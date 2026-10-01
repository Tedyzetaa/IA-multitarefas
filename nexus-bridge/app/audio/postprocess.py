import re

import numpy as np

from .text_prep import sanitize_text


def normalize_spacing(text: str) -> str:
    return re.sub(r"\s+", " ", sanitize_text(text)).strip()


def finalize_text(text: str) -> str:
    value = normalize_spacing(text)
    if not value:
        return ""
    value = value[0].upper() + value[1:]
    if value[-1] not in ".!?":
        value += "."
    return value


def merge_audio_segments(chunks: list[np.ndarray], sample_rate: int) -> np.ndarray:
    if not chunks:
        return np.array([], dtype=np.float32)
    total = sum(len(chunk) for chunk in chunks)
    merged = np.zeros(total, dtype=np.float32)
    offset = 0
    for chunk in chunks:
        arr = np.asarray(chunk, dtype=np.float32)
        merged[offset:offset + len(arr)] = arr
        offset += len(arr)
    return merged
