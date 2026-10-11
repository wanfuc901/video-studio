"""Karaoke Pro pipeline: separate vocals, remove reverb, find words, then refine onsets, held notes and echo.

Stages (each reports progress and can be cancelled between steps):
  1. decode     only the requested range of the source file (PyAV), 44.1 kHz stereo
  2. separate   vocal stem (Roformer via audio-separator)            -> "wet" vocals with reverb
  3. dereverb   de-echo/de-reverb model on the vocal stem             -> "dry" vocals
  4. words      lyrics supplied: CTC forced alignment of the exact lyrics on dry vocals
                no lyrics:       Whisper on dry vocals, then CTC re-alignment of its words
  5. refine     snap starts to vocal onsets, extend held notes (ngân), measure echo tails (vang)
  6. beats      tempo and beat grid of the full mix
"""
from __future__ import annotations

import logging
import math
import os
import re
import tempfile
import time
import unicodedata
from pathlib import Path
from typing import Callable

import numpy as np

from ctc_align import align_words
from vocal_analysis import (FRAME_SECONDS, WordTiming, apply_sustain, beat_grid, frame_db, line_echo_ends,
                            snap_onsets, vocal_onsets, voiced_mask)

MIX_RATE = 44100
ASR_RATE = 16000
BEAT_RATE = 22050
EMISSION_WINDOW_SECONDS = 30.0
EMISSION_CONTEXT_SECONDS = 2.0
LOW_CONFIDENCE = 0.15
VOCAL_MODEL = os.environ.get('VS_VOCAL_MODEL', 'mel_band_roformer_kim_ft_unwa.ckpt')
SEPARATION_OVERLAP = int(os.environ.get('VS_SEPARATION_OVERLAP', '2'))
DEREVERB_MODEL = os.environ.get('VS_DEREVERB_MODEL', 'dereverb-echo_mel_band_roformer_sdr_13.4843_v2.ckpt')
ALIGNERS = {
    'vi': ('nguyenvulebinh/wav2vec2-base-vietnamese-250h', False),
    'en': ('facebook/wav2vec2-base-960h', False),
    '*': ('MahmoudAshraf/mms-300m-1130-forced-aligner', True),  # romanized via uroman
}
WHISPER_LANGUAGES = {'vi', 'en', 'zh', 'ko', 'ja'}
log = logging.getLogger('video-studio-karaoke')


class PipelineError(Exception):
    """Message is safe to show to the user."""


class Cancelled(Exception):
    pass


def guess_language(text: str) -> str:
    if re.search(r'[가-힯]', text):
        return 'ko'
    if re.search(r'[぀-ヿ]', text):
        return 'ja'
    if re.search(r'[一-鿿]', text):
        return 'zh'
    if re.search(r'[ăâđêôơưàáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]', unicodedata.normalize('NFC', text.lower())):
        return 'vi'
    return 'en'


def decode_range(path: str, start: float, end: float) -> np.ndarray:
    """Decodes only [start, end) of the first audio stream as float32 (2, N) at 44.1 kHz."""
    import av
    try:
        container = av.open(path)
    except av.error.FFmpegError as error:
        raise PipelineError('Không mở được tệp media. Hãy dùng MP4/MP3/WAV/M4A phổ biến.') from error
    with container:
        stream = next((s for s in container.streams if s.type == 'audio'), None)
        if stream is None:
            raise PipelineError('Tệp không có âm thanh.')
        if start > 0:
            container.seek(int(max(0.0, start - 1.0) * av.time_base))
        resampler = av.AudioResampler(format='fltp', layout='stereo', rate=MIX_RATE)
        chunks, origin, collected = [], None, 0
        wanted = int(math.ceil((end - start) * MIX_RATE))
        for frame in container.decode(stream):
            if origin is None:
                origin = float(frame.time) if frame.time is not None else 0.0
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray())
                collected += out.samples
            if origin + collected / MIX_RATE >= end:
                break
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray())
    if not chunks:
        raise PipelineError('Đoạn đã chọn không có âm thanh.')
    audio = np.concatenate(chunks, axis=1).astype(np.float32)
    offset = max(0, int(round((start - (origin or 0.0)) * MIX_RATE)))
    audio = audio[:, offset:offset + wanted]
    if audio.shape[1] < MIX_RATE * 0.2:
        raise PipelineError('Đoạn đã chọn quá ngắn hoặc nằm ngoài thời lượng tệp.')
    return audio


def to_mono(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    import librosa
    mono = audio.mean(axis=0) if audio.ndim == 2 else audio
    return librosa.resample(mono.astype(np.float32), orig_sr=source_rate, target_sr=target_rate).astype(np.float32)


class ModelHub:
    """Loads models lazily and keeps them for the next song; all heavy imports live here."""

    def __init__(self, device: str, compute_type: str, model_dir: Path, work_root: Path):
        self.device, self.compute_type, self.model_dir, self.work_root = device, compute_type, model_dir, work_root
        work_root.mkdir(parents=True, exist_ok=True)
        self.whisper_models, self.separators, self.aligners = {}, {}, {}

    def separator(self, model_filename: str, output_dir: Path):
        from audio_separator.separator import Separator
        separator = self.separators.get(model_filename)
        if separator is None:
            # Roformer default overlap re-processes each chunk many times; 2 keeps quality and is ~3x faster.
            separator = Separator(log_level=logging.WARNING, model_file_dir=str(self.model_dir / 'separator'),
                                  output_dir=str(output_dir), output_format='WAV', use_autocast=self.device == 'cuda',
                                  mdxc_params={'segment_size': 256, 'override_model_segment_size': False, 'batch_size': 1,
                                               'overlap': SEPARATION_OVERLAP, 'pitch_shift': 0})
            separator.load_model(model_filename=model_filename)
            self.separators[model_filename] = separator
        separator.output_dir = str(output_dir)
        if hasattr(separator, 'model_instance') and separator.model_instance is not None:
            separator.model_instance.output_dir = str(output_dir)
        return separator

    def whisper(self, name: str):
        if name not in self.whisper_models:
            from faster_whisper import WhisperModel
            self.whisper_models.clear()  # one Whisper at a time on a 6 GB GPU
            self.whisper_models[name] = WhisperModel(name, device=self.device, compute_type=self.compute_type,
                                                     download_root=str(self.model_dir / 'whisper'))
        return self.whisper_models[name]

    def aligner(self, language: str):
        key = language if language in ALIGNERS else '*'
        if key not in self.aligners:
            import torch
            from transformers import AutoProcessor, Wav2Vec2ForCTC
            repo, romanize = ALIGNERS[key]
            cache = str(self.model_dir / 'aligner')
            processor = AutoProcessor.from_pretrained(repo, cache_dir=cache)
            model = Wav2Vec2ForCTC.from_pretrained(repo, cache_dir=cache).to(self.torch_device()).eval()
            vocab = processor.tokenizer.get_vocab()
            blank = vocab.get('<blank>', processor.tokenizer.pad_token_id)
            self.aligners[key] = {'processor': processor, 'model': model, 'vocab': vocab, 'blank': blank,
                                  'separator': vocab.get('|'), 'romanize': romanize, 'name': repo, 'torch': torch}
        return self.aligners[key]

    def torch_device(self) -> str:
        return 'cuda' if self.device == 'cuda' else 'cpu'

    def release_cache(self) -> None:
        if self.device == 'cuda':
            import torch
            torch.cuda.empty_cache()


def separate_stem(hub: ModelHub, model_filename: str, input_path: Path, work_dir: Path, wanted: tuple[str, ...]) -> Path:
    separator = hub.separator(model_filename, work_dir)
    outputs = [Path(p) if os.path.isabs(p) else work_dir / p for p in separator.separate(str(input_path))]
    hub.release_cache()
    for path in outputs:
        stem = path.stem.lower().replace(' ', '')
        if any(f'({name})' in stem for name in wanted):
            return path
    raise PipelineError(f'Mô hình {model_filename} không trả về stem {wanted[0]}.')


def read_wav(path: Path) -> np.ndarray:
    import soundfile
    data, rate = soundfile.read(str(path), dtype='float32', always_2d=True)
    if rate != MIX_RATE:
        import librosa
        data = librosa.resample(data.T, orig_sr=rate, target_sr=MIX_RATE).T
    return data.T


def emissions_for(aligner: dict, audio16k: np.ndarray, check: Callable[[], None]) -> tuple[np.ndarray, float]:
    """Frame log-probabilities, computed in 30 s windows with 2 s context (attention is O(n^2) in length)."""
    torch, model, processor = aligner['torch'], aligner['model'], aligner['processor']
    device = next(model.parameters()).device
    window, context = int(EMISSION_WINDOW_SECONDS * ASR_RATE), int(EMISSION_CONTEXT_SECONDS * ASR_RATE)
    parts, stride = [], None
    for begin in range(0, audio16k.size, window):
        check()
        left, right = max(0, begin - context), min(audio16k.size, begin + window + context)
        inputs = processor(audio16k[left:right], sampling_rate=ASR_RATE, return_tensors='pt').input_values.to(device)
        with torch.inference_mode():
            logits = model(inputs).logits[0].float()
        log_probs = torch.log_softmax(logits, dim=-1).cpu().numpy()
        stride = stride or (right - left) / log_probs.shape[0]
        first = int(round((begin - left) / stride))
        count = int(round((min(begin + window, audio16k.size) - begin) / stride))
        parts.append(log_probs[first:first + count])
    return np.concatenate(parts), stride / ASR_RATE


def romanize_words(words: list[str]) -> list[str]:
    try:
        import uroman
    except ImportError as error:
        raise PipelineError('Thiếu gói uroman để căn lời ngôn ngữ này. Chạy lại start-windows.cmd.') from error
    roman = uroman.Uroman()
    return [re.sub(r"[^a-z']", '', roman.romanize_string(word).lower()) for word in words]


def ctc_word_timings(aligner: dict, audio16k: np.ndarray, words: list[str], check) -> list[WordTiming]:
    emissions, seconds_per_frame = emissions_for(aligner, audio16k, check)
    targets = romanize_words(words) if aligner['romanize'] else words
    spans = align_words(emissions, targets, aligner['vocab'], aligner['blank'], aligner['separator'])
    timings = []
    for word, span in zip(words, spans):
        if span is None:
            timings.append(WordTiming(word, math.nan, math.nan, None, True))
        else:
            timings.append(WordTiming(word, span.start_frame * seconds_per_frame, span.end_frame * seconds_per_frame,
                                      round(span.score, 3), span.score < LOW_CONFIDENCE))
    fill_missing(timings, audio16k.size / ASR_RATE)
    return timings


def fill_missing(words: list[WordTiming], duration: float) -> None:
    """Words without characters the model knows share the gap between their aligned neighbours."""
    index = 0
    while index < len(words):
        if not math.isnan(words[index].start):
            index += 1
            continue
        first = index
        while index < len(words) and math.isnan(words[index].start):
            index += 1
        begin = words[first - 1].end if first else 0.0
        finish = words[index].start if index < len(words) else duration
        step = max(0.02, (finish - begin) / (index - first))
        for offset, word in enumerate(words[first:index]):
            word.start, word.end, word.estimated = begin + offset * step, begin + (offset + 1) * step, True


def whisper_lines(hub: ModelHub, model_name: str, audio16k: np.ndarray, language: str | None, check):
    model = hub.whisper(model_name)
    segments, info = model.transcribe(audio16k, language=language, word_timestamps=True, beam_size=5,
                                      vad_filter=False, condition_on_previous_text=False, temperature=0.0)
    lines = []
    for segment in segments:
        check()
        # Repetition loops and music-only segments are classic Whisper hallucinations on songs.
        if segment.compression_ratio > 2.4 or (segment.no_speech_prob > 0.6 and segment.avg_logprob < -1.0):
            continue
        words = [WordTiming(w.word.strip(), w.start, w.end, round(w.probability, 3), w.probability < 0.3)
                 for w in (segment.words or []) if w.word.strip()]
        if words:
            lines.append(words)
    return lines, info.language


def run_pipeline(hub: ModelHub, source_path: Path, options: dict, report: Callable[[str, float], None],
                 check: Callable[[], None]) -> dict:
    timings: dict[str, float] = {}
    started = time.perf_counter()

    def stage(name: str):
        check()
        now = time.perf_counter()
        timings[name] = now
        report(name, 0.0)

    start, end = float(options['from']), float(options['to'])
    lyrics: list[str] | None = options.get('lyrics')
    language = options.get('language') or 'auto'
    if language == 'auto' and lyrics:
        language = guess_language(' '.join(lyrics))
    work_dir = Path(tempfile.mkdtemp(prefix='job-', dir=hub.work_root))
    try:
        stage('decode')
        mix = decode_range(str(source_path), start, end)
        duration = mix.shape[1] / MIX_RATE
        wet, dry = mix, mix
        import soundfile
        if options.get('separate', True):
            stage('separate')
            mix_path = work_dir / 'mix.wav'
            soundfile.write(str(mix_path), mix.T, MIX_RATE, subtype='FLOAT')
            vocals_path = separate_stem(hub, VOCAL_MODEL, mix_path, work_dir, ('vocals',))
            wet = dry = read_wav(vocals_path)
            if options.get('dereverb', True):
                stage('dereverb')
                dry_path = separate_stem(hub, DEREVERB_MODEL, vocals_path, work_dir, ('noreverb', 'dry', 'no reverb'))
                dry = read_wav(dry_path)
        dry16, wet16 = to_mono(dry, MIX_RATE, ASR_RATE), to_mono(wet, MIX_RATE, ASR_RATE)

        stage('words')
        if lyrics:
            line_words = [line.split() for line in lyrics]
            flat = [word for words in line_words for word in words]
            aligned = ctc_word_timings(hub.aligner(language), dry16, flat, check)
            lines, cursor = [], 0
            for words in line_words:
                lines.append(aligned[cursor:cursor + len(words)])
                cursor += len(words)
            texts = [' '.join(words) for words in line_words]
        else:
            whisper_language = language if language in WHISPER_LANGUAGES else None
            lines, detected = whisper_lines(hub, options.get('model') or 'large-v3', dry16, whisper_language, check)
            language = detected or language
            texts = [' '.join(w.word for w in line) for line in lines]
            if lines:
                flat = [w.word for line in lines for w in line]
                report('words', 0.6)
                realigned = ctc_word_timings(hub.aligner(language), dry16, flat, check)
                cursor = 0
                for line in lines:
                    for word in line:
                        better = realigned[cursor]
                        cursor += 1
                        if not better.estimated:
                            word.start, word.end, word.score = better.start, better.end, better.score
        if not any(lines):
            raise PipelineError('Không nhận ra lời hát trong đoạn này. Hãy chọn đoạn còn giọng hát.')

        stage('refine')
        flat_words = [w for line in lines for w in line]
        snap_onsets(flat_words, vocal_onsets(dry16))
        report('refine', 0.3)
        voiced = voiced_mask(dry16)
        report('refine', 0.7)
        apply_sustain(flat_words, frame_db(dry16), voiced, duration)
        echoes = line_echo_ends(lines, frame_db(wet16), duration)

        tempo, beats = 0.0, []
        if options.get('beats', True):
            stage('beats')
            tempo, beats = beat_grid(to_mono(mix, MIX_RATE, BEAT_RATE), BEAT_RATE)
        timings['total'] = time.perf_counter()
        return {
            'language': language, 'device': hub.device, 'aligner': hub.aligner(language)['name'],
            'separated': bool(options.get('separate', True)), 'dereverbed': bool(options.get('separate', True) and options.get('dereverb', True)),
            'duration': round(duration, 3), 'tempo': round(tempo, 2), 'beats': beats,
            'lines': [serialize_line(text, words, echo) for text, words, echo in zip(texts, lines, echoes) if words],
            'timings': stage_durations(timings, started),
        }
    finally:
        for path in work_dir.glob('*'):
            path.unlink(missing_ok=True)
        work_dir.rmdir()


def serialize_line(text: str, words: list[WordTiming], echo_end: float) -> dict:
    # Model outputs carry numpy scalars (np.bool_, np.float32) that json.dumps rejects; emit plain Python types.
    def word_dict(word: WordTiming) -> dict:
        start = float(word.start)
        return {'word': str(word.word), 'start': round(start, 3), 'end': round(max(float(word.end), start + 0.02), 3),
                'score': None if word.score is None else round(float(word.score), 3),
                'estimated': bool(word.estimated), 'sustain': round(float(word.sustain), 3)}
    serialized = [word_dict(w) for w in words]
    return {'text': text, 'start': serialized[0]['start'], 'end': serialized[-1]['end'],
            'echoEnd': round(max(float(echo_end), serialized[-1]['end']), 3), 'words': serialized}


def stage_durations(marks: dict[str, float], started: float) -> dict[str, float]:
    ordered = sorted(marks.items(), key=lambda item: item[1])
    result, previous_name, previous_time = {}, None, started
    for name, moment in ordered:
        if previous_name:
            result[previous_name] = round(moment - previous_time, 2)
        previous_name, previous_time = name, moment
    result['total'] = round(marks.get('total', previous_time) - started, 2)
    return result
