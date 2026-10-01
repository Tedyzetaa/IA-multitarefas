import numpy as np
from scipy import signal


def normalize_rms(signal: np.ndarray, target_rms: float = 0.1, eps: float = 1e-8) -> np.ndarray:
    """Normaliza um sinal mono para um RMS alvo sem distorcer o formato."""
    arr = np.asarray(signal, dtype=np.float32)
    if arr.size == 0:
        return arr.copy()

    rms = float(np.sqrt(np.mean(np.square(arr))))
    if rms < eps:
        return arr.copy()

    scale = target_rms / rms
    return np.clip(arr * scale, -1.0, 1.0).astype(np.float32)


def apply_rms_target(signal: np.ndarray, target_rms: float = 0.1) -> np.ndarray:
    return normalize_rms(signal, target_rms=target_rms)


def trim_silence(signal: np.ndarray, threshold_db: float = -35.0) -> np.ndarray:
    """Remove silêncio de borda com base em energia RMS."""
    arr = np.asarray(signal, dtype=np.float32)
    if arr.size == 0:
        return arr.copy()

    energy = np.abs(arr)
    threshold = np.max(energy) * (10 ** (threshold_db / 20.0))
    mask = energy > threshold
    if not np.any(mask):
        return arr.copy()
    start = int(np.argmax(mask))
    end = int(len(arr) - np.argmax(mask[::-1]))
    return arr[start:end]
