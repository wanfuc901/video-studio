"""Loopback-only AI bridge for Video Studio: Faster Whisper transcription and the Karaoke Pro pipeline. Python 3.10+."""
import argparse
import hmac
import importlib.util
import io
import json
import os
import queue
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
import uuid
import wave
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODELS = {'tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'}
LANGUAGES = {'vi', 'en', 'zh', 'ko', 'ja'}
MAX_BODY = 20 * 1024 * 1024
MAX_JOB_JSON = 256 * 1024
MAX_UPLOAD = 2 * 1024 * 1024 * 1024
MAX_SEGMENT_SECONDS = 600
UPLOAD_CHUNK = 1024 * 1024
KEPT_JOBS = 8
SITE_ORIGIN = 'https://video-studio-phuc.windyray8.chatgpt.site'
PAGES_ORIGIN = 'https://wanfuc901.github.io'
JOB_PATH = re.compile(r'^/v1/karaoke/jobs/([0-9a-f]{32})(/audio)?$')
STAGE_WEIGHTS = {'queued': 0, 'decode': .02, 'separate': .05, 'dereverb': .35, 'words': .55, 'refine': .8, 'beats': .92}


def parse_audio(content_type, body):
    if not content_type.startswith('multipart/form-data;'):
        raise ValueError('Expected multipart audio upload')
    envelope = BytesParser(policy=policy.default).parsebytes(
        ('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode('ascii') + body)
    fields, audio = {}, None
    for part in envelope.iter_parts():
        name = part.get_param('name', header='content-disposition')
        payload = part.get_payload(decode=True) or b''
        if name == 'file':
            audio = payload
        elif name in {'model', 'language'}:
            fields[name] = payload.decode('utf-8').strip()
    if fields.get('model') not in MODELS or not audio:
        raise ValueError('Choose a supported Whisper model and audio file')
    with wave.open(io.BytesIO(audio), 'rb') as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000:
            raise ValueError('Expected 16 kHz mono PCM16 WAV')
        if not 0 < wav.getnframes() <= MAX_SEGMENT_SECONDS * 16000:
            raise ValueError('Audio must be between 0 and 600 seconds')
    if fields.get('language') not in {None, *LANGUAGES}:
        raise ValueError('Unsupported language')
    return fields, audio


def parse_job_options(raw):
    """Validates the karaoke job request; raises ValueError with a user-facing reason."""
    if not isinstance(raw, dict):
        raise ValueError('Invalid job request')
    start, end = raw.get('from'), raw.get('to')
    if not all(isinstance(v, (int, float)) for v in (start, end)) or start < 0 or end <= start or end - start > MAX_SEGMENT_SECONDS:
        raise ValueError('Đoạn âm thanh phải dài từ 0 tới 600 giây')
    language = raw.get('language', 'auto')
    if language not in {'auto', *LANGUAGES}:
        raise ValueError('Ngôn ngữ chưa được hỗ trợ')
    model = raw.get('model', 'large-v3')
    if model not in MODELS:
        raise ValueError('Model Whisper không hợp lệ')
    lyrics = raw.get('lyrics')
    if lyrics is not None:
        if not isinstance(lyrics, list) or not all(isinstance(line, str) for line in lyrics):
            raise ValueError('Lyrics phải là danh sách dòng')
        lyrics = [line.strip() for line in lyrics if line.strip()]
        if not lyrics or sum(len(line.split()) for line in lyrics) > 2000:
            raise ValueError('Lyrics trống hoặc quá 2.000 từ')
    flags = {name: bool(raw.get(name, True)) for name in ('separate', 'dereverb', 'beats')}
    return {'from': float(start), 'to': float(end), 'language': language, 'model': model, 'lyrics': lyrics, **flags}


def installed(module):
    return importlib.util.find_spec(module) is not None


def karaoke_features():
    core = all(installed(name) for name in ('numpy', 'librosa', 'soundfile', 'transformers', 'torch', 'av'))
    return {'karaoke': core, 'separation': core and installed('audio_separator'), 'romanize': installed('uroman')}


class Engine:
    def __init__(self, device, compute_type, model_dir=None):
        self.device, self.compute_type = device, compute_type
        self.model_dir = model_dir
        self.lock = threading.Lock()
        self.model, self.model_name = None, None

    def transcribe(self, fields, audio):
        from faster_whisper import WhisperModel
        model_name = fields['model']
        if self.model_name != model_name:
            self.model, self.model_name = None, None
            self.model = WhisperModel(model_name, device=self.device, compute_type=self.compute_type,
                                      download_root=str(self.model_dir / 'whisper') if self.model_dir else None)
            self.model_name = model_name
        # Singing has long vowels / music; keep VAD disabled to avoid cutting those out.
        segments, _ = self.model.transcribe(io.BytesIO(audio), language=fields.get('language'),
                                           word_timestamps=True, beam_size=5, vad_filter=False)
        words, text = [], []
        for segment in segments:
            text.append(segment.text)
            words.extend({'word': w.word, 'start': w.start, 'end': w.end} for w in (segment.words or []))
        return {'text': ''.join(text), 'words': words}


class Job:
    def __init__(self, options, directory):
        self.id = uuid.uuid4().hex
        self.options, self.directory = options, directory
        self.state, self.stage, self.progress, self.message = 'waiting-upload', 'queued', 0.0, ''
        self.result, self.error = None, None
        self.cancel_event = threading.Event()
        self.created = time.time()

    def status(self):
        payload = {'id': self.id, 'state': self.state, 'stage': self.stage, 'progress': round(self.progress, 3)}
        if self.error:
            payload['error'] = self.error
        if self.state == 'done':
            payload['result'] = self.result
        return payload


class JobRunner:
    """One GPU worker; jobs run in upload order. Finished jobs keep only their JSON result."""

    def __init__(self, hub_factory, work_root):
        self.hub_factory, self.work_root = hub_factory, work_root
        self.jobs, self.lock, self.queue, self.hub = {}, threading.Lock(), queue.Queue(), None
        threading.Thread(target=self._worker, name='karaoke-worker', daemon=True).start()

    def create(self, options):
        directory = Path(tempfile.mkdtemp(prefix='upload-', dir=self.work_root))
        job = Job(options, directory)
        with self.lock:
            self.jobs[job.id] = job
            self._prune()
        return job

    def get(self, job_id):
        with self.lock:
            return self.jobs.get(job_id)

    def enqueue(self, job):
        job.state = 'queued'
        self.queue.put(job)

    def cancel(self, job):
        job.cancel_event.set()
        if job.state in {'waiting-upload', 'queued'}:
            self._finish(job, 'cancelled')

    def _prune(self):
        finished = sorted((j for j in self.jobs.values() if j.state in {'done', 'error', 'cancelled'}), key=lambda j: j.created)
        for job in finished[:-KEPT_JOBS]:
            del self.jobs[job.id]

    def _finish(self, job, state, error=None):
        job.state, job.error = state, error
        shutil.rmtree(job.directory, ignore_errors=True)

    def _worker(self):
        while True:
            job = self.queue.get()
            if job.cancel_event.is_set():
                self._finish(job, 'cancelled')
                continue
            self._run(job)

    def _run(self, job):
        from karaoke_pipeline import Cancelled, PipelineError, run_pipeline

        def report(stage, fraction):
            job.stage = stage
            base = STAGE_WEIGHTS.get(stage, 0)
            following = min((w for w in STAGE_WEIGHTS.values() if w > base), default=1.0)
            job.progress = base + (following - base) * fraction

        def check():
            if job.cancel_event.is_set():
                raise Cancelled()

        job.state = 'running'
        try:
            if self.hub is None:
                self.hub = self.hub_factory()
            job.result = run_pipeline(self.hub, job.directory / 'source', job.options, report, check)
            job.progress = 1.0
            self._finish(job, 'done')
        except Cancelled:
            self._finish(job, 'cancelled')
        except PipelineError as error:
            self._finish(job, 'error', str(error))
        except Exception as error:  # Model/CUDA failures: details go to the console, never lyrics or audio.
            print('Karaoke job failed:', type(error).__name__, str(error)[:500], flush=True)
            message = 'GPU hết bộ nhớ. Hãy chọn đoạn ngắn hơn hoặc model Whisper nhỏ hơn.' if 'out of memory' in str(error).lower() \
                else 'Pipeline lỗi; xem cửa sổ bộ chạy local để biết chi tiết.'
            self._finish(job, 'error', message)


def make_handler(engine, token, origins, jobs=None):
    class Handler(BaseHTTPRequestHandler):
        # Never log tokens, audio, lyrics or transcripts.
        def log_message(self, *_):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def origin_allowed(self):
            return self.headers.get('Origin') in origins or self.headers.get('Origin') is None

        def authorized(self):
            value = self.headers.get('Authorization', '')
            return hmac.compare_digest(value.encode(), ('Bearer ' + token).encode())

        def reply(self, status, payload=None):
            data = json.dumps(payload or {}, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            origin = self.headers.get('Origin')
            if origin in origins:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                self.send_header('Access-Control-Allow-Private-Network', 'true')
                self.send_header('Access-Control-Max-Age', '600')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # The browser stopped waiting (cancel/close); nothing left to deliver.

        def guard(self):
            if not self.origin_allowed() or not self.authorized():
                self.reply(403, {'error': 'Invalid local connection code or origin'})
                return False
            return True

        def content_length(self, limit):
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                self.reply(400)
                return None
            if not 0 < length <= limit:
                self.reply(413)
                return None
            return length

        def do_OPTIONS(self):
            self.reply(204 if self.origin_allowed() else 403)

        def do_GET(self):
            if not self.guard():
                return
            if self.path == '/health':
                return self.reply(200, {'service': 'video-studio-local', 'device': engine.device,
                                        'compute_type': engine.compute_type, 'models': sorted(MODELS),
                                        'features': karaoke_features() if jobs else {'karaoke': False}})
            match = JOB_PATH.match(self.path)
            job = jobs.get(match.group(1)) if jobs and match and not match.group(2) else None
            if not job:
                return self.reply(404)
            self.reply(200, job.status())

        def do_DELETE(self):
            if not self.guard():
                return
            match = JOB_PATH.match(self.path)
            job = jobs.get(match.group(1)) if jobs and match and not match.group(2) else None
            if not job:
                return self.reply(404)
            jobs.cancel(job)
            self.reply(200, job.status())

        def do_PUT(self):
            if not self.guard():
                return
            match = JOB_PATH.match(self.path)
            job = jobs.get(match.group(1)) if jobs and match and match.group(2) else None
            if not job or job.state != 'waiting-upload':
                return self.reply(404)
            length = self.content_length(MAX_UPLOAD)
            if length is None:
                return
            # Stream to disk: sources can be large videos and must not sit in RAM.
            with open(job.directory / 'source', 'wb') as target:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(UPLOAD_CHUNK, remaining))
                    if not chunk:
                        return self.reply(400, {'error': 'Upload interrupted'})
                    target.write(chunk)
                    remaining -= len(chunk)
            jobs.enqueue(job)
            self.reply(202, job.status())

        def do_POST(self):
            if not self.guard():
                return
            if self.path == '/v1/karaoke/jobs' and jobs:
                return self.create_job()
            if self.path != '/v1/audio/transcriptions':
                return self.reply(404)
            length = self.content_length(MAX_BODY)
            if length is None:
                return
            if not engine.lock.acquire(blocking=False):
                return self.reply(429, {'error': 'An audio task is still running'})
            try:
                fields, audio = parse_audio(self.headers.get('Content-Type', ''), self.rfile.read(length))
                result = engine.transcribe(fields, audio)
                self.reply(200, result)
            except (ValueError, wave.Error, EOFError):
                self.reply(400, {'error': 'Invalid audio or model'})
            except Exception as error:
                print('Local model error:', type(error).__name__, str(error), flush=True)
                self.reply(500, {'error': 'Model failed; inspect local console'})
            finally:
                engine.lock.release()

        def create_job(self):
            length = self.content_length(MAX_JOB_JSON)
            if length is None:
                return
            try:
                options = parse_job_options(json.loads(self.rfile.read(length).decode('utf-8')))
            except (ValueError, UnicodeDecodeError) as error:
                return self.reply(400, {'error': str(error)})
            if not karaoke_features()['karaoke']:
                return self.reply(501, {'error': 'Chưa cài Karaoke Pro. Chạy start-windows.cmd để cài đủ thư viện.'})
            if options['separate'] and not karaoke_features()['separation']:
                return self.reply(501, {'error': 'Chưa cài audio-separator để tách giọng.'})
            job = jobs.create(options)
            self.reply(201, job.status())
    return Handler


def ai_home():
    home = Path(os.environ.get('VIDEO_STUDIO_AI_HOME') or Path(__file__).resolve().parent / '.ai-home')
    for name in ('models', 'work', 'bin'):
        (home / name).mkdir(parents=True, exist_ok=True)
    return home


def ensure_ffmpeg(home):
    """audio-separator shells out to `ffmpeg`; reuse the static binary from imageio-ffmpeg instead of a system install."""
    if shutil.which('ffmpeg') or not installed('imageio_ffmpeg'):
        return
    import imageio_ffmpeg
    target = home / 'bin' / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
    if not target.exists():
        shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(), target)
    os.environ['PATH'] = str(target.parent) + os.pathsep + os.environ.get('PATH', '')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--compute-type', choices=['int8', 'float16', 'int8_float16', 'float32'])
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--origin', action='append', help='Additional allowed editor origin')
    args = parser.parse_args()
    home = ai_home()
    os.environ.setdefault('HF_HOME', str(home / 'models' / 'huggingface'))
    ensure_ffmpeg(home)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    # int8_float16 keeps Whisper large-v3 near 2 GB so separation and alignment still fit on 6 GB GPUs.
    compute_type = args.compute_type or ('int8' if args.device == 'cpu' else 'int8_float16')
    engine = Engine(args.device, compute_type, home / 'models')

    def hub_factory():
        from karaoke_pipeline import ModelHub
        return ModelHub(args.device, compute_type, home / 'models', home / 'work')

    jobs = JobRunner(hub_factory, home / 'work')
    token = secrets.token_urlsafe(32)
    origins = {SITE_ORIGIN, PAGES_ORIGIN, 'http://localhost:8765', 'http://127.0.0.1:8765', *(args.origin or [])}
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(engine, token, origins, jobs))
    server.daemon_threads = True
    features = karaoke_features()
    print(f'Video Studio local AI: http://127.0.0.1:{args.port}\nDevice: {engine.device} / {engine.compute_type}\n'
          f'Karaoke Pro: {"ready" if features["karaoke"] else "not installed"}'
          f' · vocal separation: {"ready" if features["separation"] else "not installed"}\n'
          f'Models and temp files: {home}\nAllowed editors: {", ".join(sorted(origins))}\n'
          f'Connection code (paste in the editor):\n{token}\nKeep this window open. Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
