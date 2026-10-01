"""
Pre-processamento de imagem para o pipeline LTX-Video (ComfyUI).

Isolado do orchestrator e do provider de proposito: e logica pura (sem
I/O de rede), facil de testar isoladamente, e e o unico lugar que sabe
decodificar/redimensionar a imagem de entrada antes dela virar bytes PNG
prontos para upload no ComfyUI.
"""
import base64
import io
import logging

from PIL import Image, UnidentifiedImageError

logger = logging.getLogger("nexus.image_utils")


class InvalidImageError(ValueError):
    """Levantada quando input_image_base64 nao decodifica como imagem valida."""
    pass


def resize_image_b64(image_base64: str, max_side: int) -> bytes:
    """
    Decodifica uma imagem base64 (sem prefixo "data:image/...;base64,") e
    redimensiona mantendo a proporcao, de forma que o maior lado nunca
    ultrapasse `max_side` px.

    Existe para evitar estouro de VRAM no LTX-Video: video multiplica o
    consumo de memoria em relacao a uma imagem unica (dezenas de frames
    "empilhados"), entao a imagem de entrada do pipeline de image-to-video
    e sempre limitada a um teto pequeno (ver settings.LTX_INPUT_IMAGE_MAX_SIDE
    em config.py), independentemente do tamanho que o usuario enviou.

    Imagens menores que `max_side` NAO sao ampliadas -- so reduzimos,
    nunca aumentamos (evita introduzir blur artificial).

    Sempre retorna PNG (bytes), independente do formato de entrada, e
    sempre em RGB (remove canal alfa/paleta, que o LoadImage do ComfyUI
    nao espera nesse ponto do grafo).
    """
    try:
        raw = base64.b64decode(image_base64, validate=True)
    except Exception as e:
        raise InvalidImageError(
            f"input_image_base64 invalido (nao decodifica como base64): {e}"
        ) from e

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError) as e:
        raise InvalidImageError(f"input_image_base64 nao e uma imagem valida: {e}") from e

    if img.mode != "RGB":
        img = img.convert("RGB")

    width, height = img.size
    if max(width, height) > max_side:
        scale = max_side / float(max(width, height))
        new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        img = img.resize(new_size, Image.LANCZOS)
        logger.info(
            "Imagem de entrada redimensionada de %sx%s para %sx%s (teto=%spx)",
            width, height, new_size[0], new_size[1], max_side,
        )

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
