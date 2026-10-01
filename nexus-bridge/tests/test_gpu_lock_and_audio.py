import asyncio

import numpy as np

from app.gpu_lock import gpu_vram_lock
from app.audio.text_prep import partition_long_sentences, sanitize_text
from app.audio.voice_prep import normalize_rms


def test_gpu_lock_is_asyncio_lock():
    assert isinstance(gpu_vram_lock, asyncio.locks.Lock)


def test_sanitize_and_partition_long_text():
    text = "  Olá!   Tudo bem com você? Este texto é uma frase muito longa para ser quebrada automaticamente em partes menores sem perder a estrutura.  "
    clean = sanitize_text(text)
    chunks = partition_long_sentences(clean, max_chars=160)

    assert clean
    assert all(len(chunk) <= 160 for chunk in chunks)
    assert "".join(chunks).replace(" ", "") == clean.replace(" ", "")


def test_normalize_rms_target_matches_expected_value():
    signal = np.array([0.0, 1.0, 0.0, -1.0], dtype=np.float32)
    normalized = normalize_rms(signal, target_rms=0.5)

    rms = float(np.sqrt(np.mean(np.square(normalized))))
    assert np.isclose(rms, 0.5, atol=1e-3)
