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


async def generate_mesh_with_guard(mesh_provider, image_bytes: bytes, seed: int | None,
                                    export_format: str) -> str:
    """
    Guard de geracao 3D para o pipeline ComfyUI/Hunyuan3D. Em caso de OOM,
    reduz octree_resolution (unico parametro que afeta VRAM de forma
    relevante nesse grafo) ate settings.COMFYUI_3D_OCTREE_RESOLUTION_FALLBACK
    e tenta de novo, ate MAX_RETRIES_ON_OOM vezes -- mesmo padrao usado em
    generate_image_with_guard/generate_video_with_guard acima.
    """
    octree_resolution = settings.COMFYUI_3D_OCTREE_RESOLUTION
    attempt = 0

    while True:
        free_vram = get_free_vram_mb()
        if free_vram is not None and free_vram < settings.VRAM_SAFETY_MARGIN_MB:
            logger.warning(
                f"VRAM livre baixa ({free_vram}MB) antes de iniciar geracao 3D "
                f"-- aplicando octree_resolution de fallback preventivamente."
            )
            octree_resolution = settings.COMFYUI_3D_OCTREE_RESOLUTION_FALLBACK

        try:
            return await mesh_provider.generate(
                image_bytes, seed=seed, octree_resolution=octree_resolution, export_format=export_format,
            )
        except ResourceExhaustedError as e:
            attempt += 1
            logger.error(f"OOM no ComfyUI/Hunyuan3D (tentativa {attempt}, octree_resolution={octree_resolution}): {e}")
            if attempt > settings.MAX_RETRIES_ON_OOM:
                raise
            octree_resolution = settings.COMFYUI_3D_OCTREE_RESOLUTION_FALLBACK
        except ProviderUnavailableError:
            raise


async def generate_video_with_guard(video_provider, positive_prompt: str, negative_prompt: str,
                                     image_bytes: bytes, seed: int | None) -> str:
    """
    Guard de video para o pipeline ComfyUI/LTX-Video. Diferente da imagem
    (Fooocus), aqui a degradacao progressiva e limitada de proposito: so
    `length` (frames) reduz em caso de OOM, ate settings.LTX_LENGTH_FALLBACK
    (piso da faixa validada, 65 frames). Largura, altura e denoise sao
    RIGIDOS e NUNCA mudam entre tentativas -- reduzir denoise quebra o
    LTXVImgToVideo (mutacao severa do produto, ja validado empiricamente),
    e mudar resolucao exigiria re-redimensionar a imagem de entrada, o que
    nao vale a complexidade pra um recurso de ultimo caso.

    Em caso de OOM, tenta de novo (o job pode ter disputado VRAM com outro
    processo pontualmente) ate MAX_RETRIES_ON_OOM vezes, caindo pro length
    de fallback a partir da primeira falha. Se a VRAM livre ja estiver
    abaixo da margem de seguranca antes mesmo de comecar, aplica o length
    de fallback preventivamente (mesmo padrao usado no guard de imagem).
    """
    length = settings.LTX_LENGTH
    attempt = 0

    while True:
        free_vram = get_free_vram_mb()
        if free_vram is not None and free_vram < settings.VRAM_SAFETY_MARGIN_MB:
            logger.warning(
                f"VRAM livre baixa ({free_vram}MB) antes de iniciar geracao de video "
                f"-- aplicando length de fallback ({settings.LTX_LENGTH_FALLBACK} frames) preventivamente."
            )
            length = settings.LTX_LENGTH_FALLBACK

        try:
            return await video_provider.generate(
                positive_prompt=positive_prompt,
                negative_prompt=negative_prompt,
                image_bytes=image_bytes,
                width=settings.LTX_WIDTH,
                height=settings.LTX_HEIGHT,
                length=length,
                denoise=settings.LTX_DENOISE,
                seed=seed,
            )
        except ResourceExhaustedError as e:
            attempt += 1
            logger.error(f"OOM no ComfyUI/LTX-Video (tentativa {attempt}, length={length}): {e}")
            if attempt > settings.MAX_RETRIES_ON_OOM:
                raise
            length = settings.LTX_LENGTH_FALLBACK
        except ProviderUnavailableError:
            raise
