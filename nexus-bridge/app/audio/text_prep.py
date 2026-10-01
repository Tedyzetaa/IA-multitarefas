import re
import unicodedata

import numpy as np


def sanitize_text(text: str) -> str:
    """Normaliza texto bruto removendo ruído e normalizando espaçamento."""
    if text is None:
        return ""
    value = unicodedata.normalize("NFKC", str(text))
    value = value.replace("\r", "\n").replace("\t", " ")
    value = re.sub(r"\s+", " ", value)
    value = value.strip(" \n\t")
    value = re.sub(r"[\u200b\u200c\u200d\ufeff]", "", value)
    value = re.sub(r"\s+([,.;:!?])", r"\1", value)
    return value.strip()


def _split_sentences(text: str) -> list[str]:
    pieces = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [p.strip() for p in pieces if p and p.strip()]


def partition_long_sentences(text: str, max_chars: int = 160) -> list[str]:
    """Quebra sentenças longas em blocos de até max_chars, preservando estrutura."""
    clean = sanitize_text(text)
    if not clean:
        return []

    chunks: list[str] = []
    for sentence in _split_sentences(clean):
        if len(sentence) <= max_chars:
            chunks.append(sentence)
            continue

        words = sentence.split()
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if len(candidate) <= max_chars:
                current = candidate
                continue
            if current:
                chunks.append(current)
            current = word
        if current:
            chunks.append(current)

    if not chunks:
        return [clean]
    return chunks
