"""
Provider para geracao de video via LTX-Video, rodando localmente como
SUBPROCESSO (o "servidor" e o proprio inference.py do repo clonado em
LTX_VIDEO_PATH -- diferente do Ollama/Fooocus, nao ha API HTTP aqui).

## ATENCAO: VRAM (RTX 3050 6GB)
So a variante DISTILLED do checkpoint 2B tem alguma chance real de caber em
6GB (com FP8 + tiling). O checkpoint 13B, mesmo distilled/FP8, precisa de
14-18GB -- nao roda nesta GPU em nenhuma configuracao. O default em
config.py (LTX_PIPELINE_CONFIG) ja aponta para o 2B distilled; nao troque
para um config 13b-* sem trocar de GPU tambem.

Mesmo com o 2B, espere ter que rodar em resolucao baixa e poucos frames --
video multiplica o consumo de VRAM comparado a imagem (dezenas de frames
"empilhados", nao um frame so), entao a margem de seguranca aqui e mais
apertada que no Fooocus. O resource_manager.generate_video_with_guard cobre
o retry automatico com resolucao/frames reduzidos, igual ja acontece com
steps/resolucao no pipeline de imagem.
"""
import asyncio
import logging
import uuid
from pathlib import Path

from app.config import settings
from app.models import VideoGenerateRequest
from app.providers.base import VideoProvider, ProviderUnavailableError, ResourceExhaustedError

logger = logging.getLogger("nexus.ltx_video_provider")

# Trechos tipicos de stderr do PyTorch/CUDA quando a VRAM estoura -- usados
# para decidir se o resource_manager deve tentar de novo com parametros
# menores (ResourceExhaustedError) ou desistir na hora (ProviderUnavailableError).
_OOM_MARKERS = (
    "CUDA out of memory",
    "CUBLAS_STATUS_ALLOC_FAILED",
    "OutOfMemoryError",
    "cudaErrorMemoryAllocation",
)

# No Windows, VRAM insuficiente as vezes derruba o processo direto com um
# access violation (STATUS_ACCESS_VIOLATION = 0xC0000005 = 3221225477) em
# vez de uma excecao Python limpa com uma das mensagens acima -- sobretudo
# durante o carregamento dos checkpoint shards, antes da inferencia
# comecar. Trata como OOM tambem, senao o retry com resolucao/frames
# reduzidos do resource_manager nunca dispara nesse caso.
_CRASH_RETURNCODES_LIKELY_OOM = (3221225477,)


class LtxVideoProvider(VideoProvider):
    def __init__(self, ltx_path: Path | str | None = None):
        self.ltx_path = Path(ltx_path or settings.LTX_VIDEO_PATH)
        self.inference_script = self.ltx_path / "inference.py"

    async def generate(self, refined_prompt: str, req: VideoGenerateRequest,
                        height: int, width: int, num_frames: int) -> str:
        if not self.inference_script.exists():
            raise ProviderUnavailableError(
                f"inference.py nao encontrado em '{self.inference_script}'. "
                f"Confira LTX_VIDEO_PATH no .env -- deve apontar para a pasta "
                f"onde 'git clone https://github.com/Lightricks/LTX-Video' foi rodado "
                f"(config atual: {self.ltx_path})."
            )

        settings.OUTPUT_DIR_VIDEOS.mkdir(parents=True, exist_ok=True)
        output_path = settings.OUTPUT_DIR_VIDEOS / f"{uuid.uuid4()}.mp4"

        seed = req.seed if req is not None and req.seed is not None else 42

        args = [
            settings.LTX_VIDEO_PYTHON, str(self.inference_script),
            "--prompt", refined_prompt,
            "--height", str(height),
            "--width", str(width),
            "--num_frames", str(num_frames),
            "--seed", str(seed),
            "--pipeline_config", settings.LTX_PIPELINE_CONFIG,
            "--output_path", str(output_path),
        ]
        if settings.LTX_OFFLOAD_TO_CPU:
            args.append("--offload_to_cpu")

        logger.info(
            "[LTX] Gerando video %sx%s, %s frames (seed=%s)...",
            width, height, num_frames, seed,
        )

        try:
            # asyncio.create_subprocess_exec (nao subprocess.run) para nao
            # bloquear o event loop -- mesmo com um job por vez na fila, o
            # FastAPI continua precisando responder /api/jobs/{id} e
            # /api/status enquanto o LTX roda (pode levar minutos numa 3050).
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(self.ltx_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
        except FileNotFoundError as e:
            # O interpretador em settings.LTX_VIDEO_PYTHON (default "python")
            # nao foi encontrado -- comum se apontar pra um venv cujo caminho
            # esta errado, ou se depender do PATH do processo do nexus-bridge.
            raise ProviderUnavailableError(
                f"Nao foi possivel executar o interpretador Python "
                f"('{settings.LTX_VIDEO_PYTHON}') para o LTX-Video: {e}. "
                f"Confira LTX_VIDEO_PYTHON no .env."
            ) from e

        stderr_text = stderr.decode(errors="ignore")

        if proc.returncode != 0 or not output_path.exists():
            is_oom = (
                any(marker in stderr_text for marker in _OOM_MARKERS)
                or proc.returncode in _CRASH_RETURNCODES_LIKELY_OOM
            )
            if is_oom:
                raise ResourceExhaustedError(
                    f"CUDA OOM (ou crash provavelmente por VRAM, codigo {proc.returncode}) "
                    f"no LTX-Video ({width}x{height}, {num_frames} frames): "
                    f"{stderr_text[-500:]}"
                )
            raise ProviderUnavailableError(
                f"LTX-Video terminou com erro (codigo {proc.returncode}): {stderr_text[-1000:]}"
            )

        return str(output_path)

    async def health_check(self) -> bool:
        # Nao ha servico HTTP para consultar -- so confirmamos que o script
        # e a pasta existem, o que basta pra pegar o erro de configuracao
        # mais comum (LTX_VIDEO_PATH errado) sem disparar uma geracao real.
        return self.inference_script.exists()
