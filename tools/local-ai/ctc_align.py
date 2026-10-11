"""CTC forced alignment of known lyrics against frame-level character log-probabilities.

Pure numpy so it is unit-testable without a model. Viterbi over the standard blank-interleaved CTC
state graph; backpointers are uint8 (T x S), so a 10-minute song with ~6000 characters stays near 180 MB.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass

import numpy as np

NEG_INF = -1e30
MAX_CELLS = 400_000_000


@dataclass(frozen=True)
class WordSpan:
    index: int
    start_frame: int
    end_frame: int  # exclusive
    score: float


def normalize_word(word: str) -> str:
    return unicodedata.normalize('NFC', word).lower()


def word_token_ids(word: str, vocab: dict[str, int]) -> list[int]:
    """Characters the acoustic model knows; punctuation and unknown symbols are dropped."""
    ids = []
    for char in normalize_word(word):
        token = vocab.get(char)
        if token is None:
            token = vocab.get(char.upper())
        if token is None:
            # Decomposed fallback: e.g. models whose vocab only has base letters + combining marks.
            for part in unicodedata.normalize('NFD', char):
                part_id = vocab.get(part, vocab.get(part.upper()))
                if part_id is not None:
                    ids.append(part_id)
            continue
        ids.append(token)
    return ids


def build_targets(words: list[str], vocab: dict[str, int], separator: int | None):
    """Flattens words into one token sequence; returns tokens and the owning word of each token (-1 = separator)."""
    tokens, owners = [], []
    for index, word in enumerate(words):
        ids = word_token_ids(word, vocab)
        if not ids:
            continue
        if tokens and separator is not None:
            tokens.append(separator)
            owners.append(-1)
        tokens.extend(ids)
        owners.extend([index] * len(ids))
    return tokens, owners


def viterbi(emissions: np.ndarray, tokens: list[int], blank: int) -> np.ndarray:
    """Returns, for every frame, the index into `tokens` it emits, or -1 for blank."""
    frames = emissions.shape[0]
    states = 2 * len(tokens) + 1
    if not tokens:
        raise ValueError('Lời không có ký tự nào mô hình căn được.')
    if frames * states > MAX_CELLS:
        raise ValueError('Đoạn lời quá dài để căn một lần. Hãy chọn đoạn âm thanh ngắn hơn.')
    labels = np.full(states, blank, dtype=np.int64)
    labels[1::2] = tokens
    skip_allowed = np.zeros(states, dtype=bool)
    skip_allowed[3::2] = labels[3::2] != labels[1:-2:2]
    back = np.zeros((frames, states), dtype=np.uint8)
    alpha = np.full(states, NEG_INF)
    alpha[0] = emissions[0, blank]
    alpha[1] = emissions[0, labels[1]]
    for frame in range(1, frames):
        step = np.concatenate(([NEG_INF], alpha[:-1]))
        skip = np.concatenate(([NEG_INF, NEG_INF], alpha[:-2]))
        skip[~skip_allowed] = NEG_INF
        candidates = np.stack((alpha, step, skip))
        choice = np.argmax(candidates, axis=0)
        alpha = candidates[choice, np.arange(states)] + emissions[frame, labels]
        back[frame] = choice
    end = states - 1 if alpha[-1] >= alpha[-2] else states - 2
    if alpha[end] <= NEG_INF / 2:
        raise ValueError('Âm thanh quá ngắn so với lời đã nhập.')
    path = np.empty(frames, dtype=np.int64)
    state = end
    for frame in range(frames - 1, -1, -1):
        path[frame] = state
        state -= int(back[frame, state])
    return np.where(path % 2 == 1, (path - 1) // 2, -1)


def align_words(emissions: np.ndarray, words: list[str], vocab: dict[str, int], blank: int,
                separator: int | None = None) -> list[WordSpan | None]:
    """Aligns `words` in order. Words with no known characters return None (caller interpolates)."""
    tokens, owners = build_targets(words, vocab, separator)
    emitted = viterbi(emissions, tokens, blank)
    owner_of_frame = np.where(emitted >= 0, np.asarray(owners + [-1])[emitted], -1)
    probabilities = np.exp(emissions[np.arange(len(emitted)), np.where(emitted >= 0, np.asarray(tokens + [blank])[emitted], blank)])
    spans: list[WordSpan | None] = [None] * len(words)
    for index in range(len(words)):
        frames = np.flatnonzero(owner_of_frame == index)
        if frames.size:
            spans[index] = WordSpan(index, int(frames[0]), int(frames[-1]) + 1, float(probabilities[frames].mean()))
    return spans
