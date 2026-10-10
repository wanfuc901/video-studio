"""Loopback-only Faster Whisper bridge for Video Studio. Python 3.10+."""
import argparse
import hmac
import io
import json
import secrets
import threading
import wave
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = {'tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'}
MAX_BODY = 20 * 1024 * 1024
SITE_ORIGIN = 'https://video-studio-phuc.windyray8.chatgpt.site'


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
        if not 0 < wav.getnframes() <= 600 * 16000:
            raise ValueError('Audio must be between 0 and 600 seconds')
    if fields.get('language') not in {None, 'vi', 'en', 'zh', 'ko', 'ja'}:
        raise ValueError('Unsupported language')
    return fields, audio


class Engine:
    def __init__(self, device, compute_type):
        self.device, self.compute_type = device, compute_type
        self.lock = threading.Lock()
        self.model, self.model_name = None, None

    def transcribe(self, fields, audio):
        from faster_whisper import WhisperModel
        model_name = fields['model']
        if self.model_name != model_name:
            self.model, self.model_name = None, None
            self.model = WhisperModel(model_name, device=self.device, compute_type=self.compute_type)
            self.model_name = model_name
        # Singing has long vowels / music; keep VAD disabled to avoid cutting those out.
        segments, _ = self.model.transcribe(io.BytesIO(audio), language=fields.get('language'),
                                           word_timestamps=True, beam_size=5, vad_filter=False)
        words, text = [], []
        for segment in segments:
            text.append(segment.text)
            words.extend({'word': w.word, 'start': w.start, 'end': w.end} for w in (segment.words or []))
        return {'text': ''.join(text), 'words': words}


def make_handler(engine, token, origins):
    class Handler(BaseHTTPRequestHandler):
        # Never log tokens, audio, or transcripts.
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
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_OPTIONS(self):
            self.reply(204 if self.origin_allowed() else 403)

        def do_GET(self):
            if not self.origin_allowed() or not self.authorized():
                return self.reply(403, {'error': 'Invalid local connection code or origin'})
            if self.path != '/health':
                return self.reply(404)
            self.reply(200, {'service': 'video-studio-local', 'device': engine.device,
                             'compute_type': engine.compute_type, 'models': sorted(MODELS)})

        def do_POST(self):
            if not self.origin_allowed() or not self.authorized():
                return self.reply(403, {'error': 'Invalid local connection code or origin'})
            if self.path != '/v1/audio/transcriptions':
                return self.reply(404)
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                return self.reply(400)
            if not 0 < length <= MAX_BODY:
                return self.reply(413)
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
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--compute-type', choices=['int8', 'float16', 'int8_float16', 'float32'])
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--origin', action='append', help='Additional allowed editor origin')
    args = parser.parse_args()
    engine = Engine(args.device, args.compute_type or ('int8' if args.device == 'cpu' else 'float16'))
    token = secrets.token_urlsafe(32)
    origins = {SITE_ORIGIN, 'http://localhost:8765', 'http://127.0.0.1:8765', *(args.origin or [])}
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(engine, token, origins))
    server.daemon_threads = True
    print(f'Video Studio local AI: http://127.0.0.1:{args.port}\nDevice: {engine.device} / {engine.compute_type}\nConnection code (paste in the editor):\n{token}\nKeep this window open. Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
