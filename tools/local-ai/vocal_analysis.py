"""Timing refinements on separated vocals: word onsets, sustained notes (ngân) and echo tails (vang).

Core rules work on per-frame arrays (10 ms hop) so they are testable with synthetic signals; librosa is
only needed by the feature extractors.

- dry vocals  = vocal stem after de-reverb: where the singer's voice actually is.
- wet vocals  = vocal stem with its reverb/echo: what the listener still hears after the voice stops.
A word's karaoke wipe ends with the dry voice (including a held note); the line stays on screen
until the wet echo has faded, but never past the next line.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16000
HOP = 160  # 10 ms
FRAME_SECONDS = HOP / SAMPLE_RATE
SILENCE_DB = -80.0
SUSTAIN_DROP_DB = 20.0       # a held note stays within 20 dB of the word's peak
ECHO_DROP_DB = 35.0          # echo is audible until it falls 35 dB under the line peak
NOISE_MARGIN_DB = 6.0
SUSTAIN_GAP_FRAMES = 6       # 60 ms dips (vibrato, breath noise) do not end a held note
ECHO_GAP_FRAMES = 10
MAX_SUSTAIN_SECONDS = 8.0
MAX_ECHO_SECONDS = 4.0
MIN_SUSTAIN_SECONDS = 0.5    # a held vowel ("ngân") lasts at least 0.5 s past the CTC character spike
# CTC emits each character as a short spike inside the sound, measured ~90 ms after the real onset on
# Vietnamese TTS. Starts therefore look for a vocal onset mostly *before* the spike.
ONSET_LOOKBACK_SECONDS = 0.25
ONSET_LOOKAHEAD_SECONDS = 0.05
CTC_LAG_SECONDS = 0.06
MIN_TEMPO, MAX_TEMPO = 70.0, 160.0
MIN_WORD_SECONDS = 0.04


@dataclass
class WordTiming:
    word: str
    start: float
    end: float
    score: float | None = None
    estimated: bool = False
    sustain: float = 0.0


def frame_db(signal: np.ndarray, hop: int = HOP) -> np.ndarray:
    """RMS level per hop in dBFS (window = 2 hops, centred)."""
    if signal.size == 0:
        return np.zeros(0)
    padded = np.pad(signal.astype(np.float64), (hop, hop))
    frames = np.lib.stride_tricks.sliding_window_view(padded, 2 * hop)[::hop][: int(np.ceil(signal.size / hop))]
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    return np.maximum(20 * np.log10(np.maximum(rms, 1e-12)), SILENCE_DB)


def noise_floor(levels: np.ndarray) -> float:
    return float(np.percentile(levels, 10)) if levels.size else SILENCE_DB


def _walk_active(active: np.ndarray, start: int, limit: int, gap: int) -> int:
    """Last active frame + 1 when walking forward from `start`, tolerating inactive runs up to `gap`."""
    last, inactive = start, 0
    for frame in range(start, min(limit, active.size)):
        if active[frame]:
            last, inactive = frame + 1, 0
        else:
            inactive += 1
            if inactive > gap:
                break
    return last


def extend_sustain(start_frame: int, end_frame: int, limit_frame: int, dry_db: np.ndarray,
                   voiced: np.ndarray | None, floor_db: float) -> int:
    """End frame of the voice for a word whose aligned characters end at `end_frame`."""
    if end_frame >= limit_frame or end_frame >= dry_db.size:
        return end_frame
    peak = float(dry_db[start_frame:max(end_frame, start_frame + 1)].max())
    threshold = max(peak - SUSTAIN_DROP_DB, floor_db + NOISE_MARGIN_DB)
    active = dry_db >= threshold
    if voiced is not None:
        active &= voiced
    return max(end_frame, _walk_active(active, end_frame, limit_frame, SUSTAIN_GAP_FRAMES))


def echo_end(voice_end_frame: int, limit_frame: int, wet_db: np.ndarray, peak_db: float, floor_db: float) -> int:
    threshold = max(peak_db - ECHO_DROP_DB, floor_db + NOISE_MARGIN_DB / 2)
    return max(voice_end_frame, _walk_active(wet_db >= threshold, voice_end_frame, limit_frame, ECHO_GAP_FRAMES))


def snap_onsets(words: list[WordTiming], onset_times: np.ndarray) -> None:
    """Moves each CTC start back to the vocal onset that produced it (latest onset in [-250 ms, +50 ms]).
    Without an onset (legato, no energy dip) the known CTC lag is compensated instead."""
    for index, word in enumerate(words):
        floor = words[index - 1].start + MIN_WORD_SECONDS if index else 0.0
        window = onset_times[(onset_times >= word.start - ONSET_LOOKBACK_SECONDS) & (onset_times <= word.start + ONSET_LOOKAHEAD_SECONDS)]
        window = window[window >= floor]
        target = float(window.max()) if window.size else word.start - CTC_LAG_SECONDS
        word.start = max(floor, min(target, word.end - MIN_WORD_SECONDS))
        if index and words[index - 1].end > word.start:
            words[index - 1].end = word.start


def apply_sustain(words: list[WordTiming], dry_db: np.ndarray, voiced: np.ndarray | None, duration: float) -> None:
    """Extends word ends through held notes, never into the next word."""
    floor_db = noise_floor(dry_db)
    max_frames = int(MAX_SUSTAIN_SECONDS / FRAME_SECONDS)
    for index, word in enumerate(words):
        start, end = int(word.start / FRAME_SECONDS), int(np.ceil(word.end / FRAME_SECONDS))
        next_start = words[index + 1].start if index + 1 < len(words) else duration
        limit = min(int(next_start / FRAME_SECONDS), end + max_frames)
        voice_end = extend_sustain(start, end, limit, dry_db, voiced, floor_db) * FRAME_SECONDS
        extended = min(voice_end, next_start)
        if extended - word.end >= MIN_SUSTAIN_SECONDS:
            word.sustain = round(extended - word.end, 3)
        if extended > word.end:
            word.end = extended


def line_echo_ends(lines: list[list[WordTiming]], wet_db: np.ndarray, duration: float) -> list[float]:
    floor_db = noise_floor(wet_db)
    max_frames = int(MAX_ECHO_SECONDS / FRAME_SECONDS)
    results = []
    for index, line in enumerate(lines):
        if not line:
            results.append(0.0)
            continue
        start, end = int(line[0].start / FRAME_SECONDS), int(np.ceil(line[-1].end / FRAME_SECONDS))
        next_start = lines[index + 1][0].start if index + 1 < len(lines) and lines[index + 1] else duration
        limit = min(int(next_start / FRAME_SECONDS), end + max_frames)
        peak = float(wet_db[start:max(end, start + 1)].max()) if wet_db.size > start else SILENCE_DB
        tail = echo_end(end, limit, wet_db, peak, floor_db) * FRAME_SECONDS
        results.append(round(min(max(tail, line[-1].end), next_start), 3))
    return results


def voiced_mask(dry: np.ndarray, sample_rate: int = SAMPLE_RATE) -> np.ndarray | None:
    """pYIN voicing on the dry vocal stem, one value per 10 ms frame; None when librosa is missing."""
    try:
        import librosa
    except ImportError:
        return None
    _, voiced, _ = librosa.pyin(dry, fmin=65.0, fmax=1100.0, sr=sample_rate, frame_length=1024, hop_length=HOP, center=True)
    return np.asarray(voiced, dtype=bool)[: int(np.ceil(dry.size / HOP))]


def vocal_onsets(dry: np.ndarray, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    import librosa
    envelope = librosa.onset.onset_strength(y=dry, sr=sample_rate, hop_length=HOP)
    return librosa.onset.onset_detect(onset_envelope=envelope, sr=sample_rate, hop_length=HOP, backtrack=True, units='time')


def fold_tempo(tempo: float, beats: np.ndarray, strength_at) -> tuple[float, np.ndarray]:
    """Beat trackers often lock to double/half time. Fold into 70-160 BPM; when halving, keep the
    phase whose beats carry more onset strength (the kick/snare side)."""
    while tempo > MAX_TEMPO and beats.size >= 4:
        even, odd = beats[0::2], beats[1::2]
        beats = even if strength_at(even) >= strength_at(odd) else odd
        tempo /= 2
    while 0 < tempo < MIN_TEMPO and beats.size >= 2:
        beats = np.sort(np.concatenate([beats, (beats[:-1] + beats[1:]) / 2]))
        tempo *= 2
    return tempo, beats


def beat_grid(mix: np.ndarray, sample_rate: int) -> tuple[float, list[float]]:
    import librosa
    hop = 512
    envelope = librosa.onset.onset_strength(y=mix, sr=sample_rate, hop_length=hop)
    tempo, beats = librosa.beat.beat_track(onset_envelope=envelope, sr=sample_rate, hop_length=hop, units='time')

    def strength_at(times: np.ndarray) -> float:
        frames = np.clip((times * sample_rate / hop).astype(int), 0, envelope.size - 1)
        return float(envelope[frames].mean()) if frames.size else 0.0

    tempo, beats = fold_tempo(float(np.atleast_1d(tempo)[0]), np.asarray(beats, dtype=float), strength_at)
    return tempo, [round(float(t), 3) for t in beats]
