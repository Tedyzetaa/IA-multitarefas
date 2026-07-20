"""
Gerenciador de recursos: garante estrategia de retry gracioso em caso
de VRAM insuficiente. A exclusividade mutua entre LLM e gerador de
imagem (nunca os dois com carga pesada em VRAM ao mesmo tempo) e
garantida pelo orchestrator (unload do Ollama antes de acionar o
Fooocus) + pelo QueueManager (um job por vez).
"""
import logging
from app.providers.base import ResourceExhaustedError, ProviderUnavailableError
from app.config import settings

logger = logging.getLogger("nexus.resource_manager")

try:
    import pynvml
    pynvml.nvmlInit()
    _NVML_AVAILABLE = True
except Exception:
    _NVML_AVAILABLE = False


def get_free_vram_mb():
    """Retorna VRAM livre em MB, ou None se pynvml nao estiver disponivel."""
    if not _NVML_AVAILABLE:
        return None
    try:
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        return info.free // (1024 * 1024)
    except Exception:
        return None


async def generate_image_with_guard(image_provider, refined_prompt: str, req) -> str:
    """
    Tenta gerar a imagem com os parametros padrao. Se detectar VRAM
    insuficiente (via pynvml, quando disponivel) ou receber um erro de
    OOM do Fooocus, reduz automaticamente steps/resolucao e tenta
    novamente, ate MAX_RETRIES_ON_OOM vezes.

    `req` (GenerateRequest) carrega os parametros avancados (styles, loras,
    image prompt, inpaint/outpaint, upscale/vary etc); so steps/resolution
    sao sobrescritos aqui durante retries -- o resto do request e sempre
    repassado intacto ao provider.
    """
    steps = settings.FOOOCUS_DEFAULT_STEPS
    resolution = settings.FOOOCUS_DEFAULT_RESOLUTION
    attempt = 0

    while True:
        free_vram = get_free_vram_mb()
        if free_vram is not None and free_vram < settings.VRAM_SAFETY_MARGIN_MB:
            logger.warning(
                f"VRAM livre baixa ({free_vram}MB) antes de iniciar. "
                f"Aplicando parametros reduzidos preventivamente."
            )
            steps = settings.FOOOCUS_FALLBACK_STEPS
            resolution = settings.FOOOCUS_FALLBACK_RESOLUTION

        try:
            return await image_provider.generate(refined_prompt, req, steps=steps, resolution=resolution)
        except ResourceExhaustedError as e:
            attempt += 1
            logger.error(f"OOM detectado (tentativa {attempt}): {e}")
            if attempt > settings.MAX_RETRIES_ON_OOM:
                raise
            steps = settings.FOOOCUS_FALLBACK_STEPS
            resolution = settings.FOOOCUS_FALLBACK_RESOLUTION
        except ProviderUnavailableError:
            raise
