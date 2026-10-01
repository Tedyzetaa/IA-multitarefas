"""
Nucleo da aplicacao (core). Orquestra o pipeline Ollama -> Fooocus
usando o resource_manager para retries. Este arquivo NUNCA precisa
mudar ao trocar de provedor: apenas os objetos injetados no
construtor mudam (Dependency Injection via app/main.py).
"""
import logging
from app.config import settings
from app.constants import NEGATIVE_PROMPT_DEFAULT
from app.image_utils import InvalidImageError, resize_image_b64
from app.models import Job, JobStatus
from app.providers.base import (
    LLMProvider, ImageProvider, VideoProvider,
    ProviderUnavailableError, ResourceExhaustedError,
)
from app.resource_manager import generate_image_with_guard, generate_video_with_guard, generate_mesh_with_guard
from app.status_manager import status_manager
from app.providers.dubbing_provider import DubbingProvider
from app.providers.translation_dubbing_provider import TranslationDubbingProvider

logger = logging.getLogger("nexus.orchestrator")


class NexusOrchestrator:
    def __init__(self, llm_provider: LLMProvider, image_provider: ImageProvider,
                 video_provider: VideoProvider | None = None,
                 dubbing_provider: DubbingProvider | None = None,
                 translation_dubbing_provider: TranslationDubbingProvider | None = None,
                 mesh_provider=None):
        self.llm = llm_provider
        self.image = image_provider
        # Opcional de proposito: um deploy pode nao ter LTX-Video configurado
        # (ex: sem GPU suficiente). Jobs kind="video" falham com uma mensagem
        # clara nesse caso, em vez do sistema inteiro exigir o provider.
        self.video = video_provider
        # Idem para o pipeline 3D (Hunyuan3D via ComfyUI) -- jobs kind="3d"
        # falham com mensagem clara se nao injetado.
        self.mesh = mesh_provider
        # Duas ESTRATEGIAS de dublagem, selecionadas por job.request.dubbing_mode:
        # "voice_conversion" -> ElevenLabs Speech-to-Speech (troca a voz, nao traduz)
        # "translation_dubbing" -> pipeline local whisper->Ollama->XTTS (traduz, preserva a voz)
        self.dubbing = dubbing_provider
        self.translation_dubbing = translation_dubbing_provider

    def _select_dubbing_strategy(self, request):
        mode = getattr(request, "dubbing_mode", "translation_dubbing")
        if mode == "voice_conversion":
            return self.dubbing
        return self.translation_dubbing

    async def run(self, job: Job) -> Job:
        try:
            await status_manager.set_processing(job.id)

            # Jobs de audio (dublagem) e 3d (Hunyuan3D) nao usam LLM: audio tinha o bug de
            # ser enviado ao Ollama com o system prompt de IMAGEM e falhar se o Ollama
            # estivesse offline; 3d nao usa prompt textual algum -- o Hunyuan3D-DiT
            # condiciona so no CLIP vision embedding da imagem de entrada (ver
            # ThreeDGenerateRequest em app/models.py).
            if job.kind not in ("audio", "3d"):
                if not job.refined_prompt:
                    job.status = JobStatus.REFINING_PROMPT
                    await status_manager.set_ollama("busy")
                    logger.info("[Orchestrator] Enviando prompt para o Ollama refinar (mode=%s)...", job.kind)
                    job.refined_prompt = await self.llm.refine_prompt(job.user_prompt, mode=job.kind)
                    logger.info("[Orchestrator] Prompt refinado pelo Ollama: %s", job.refined_prompt)
                    await status_manager.set_ollama("ready")

                # Libera VRAM do LLM ANTES de acionar Fooocus/LTX-Video. Este e o
                # passo critico para notebooks com VRAM compartilhada (RTX 3050
                # 6GB): nunca deixamos Ollama e o gerador (imagem OU video) com
                # peso em memoria ao mesmo tempo.
                job.status = JobStatus.UNLOADING_LLM
                await self.llm.clear_context()

            if job.kind == "video":
                if self.video is None:
                    raise ProviderUnavailableError(
                        "Job de video recebido, mas nenhum VideoProvider foi injetado "
                        "no orchestrator (confira a instanciacao de ComfyUIVideoProvider em app/main.py)."
                    )
                job.status = JobStatus.GENERATING_VIDEO

                # Monta o payload estruturado do ComfyUI aqui, no unico lugar
                # que conhece tanto o request do usuario quanto os
                # parametros rigidos do backend:
                #   - prompt positivo: ja refinado pelo Ollama acima (job.refined_prompt)
                #   - prompt negativo: SEMPRE o template fixo, nunca o usuario (app/constants.py)
                #   - imagem de entrada: redimensionada para o teto seguro de VRAM
                try:
                    image_bytes = resize_image_b64(
                        job.request.input_image_base64, settings.LTX_INPUT_IMAGE_MAX_SIDE
                    )
                except InvalidImageError as e:
                    raise ProviderUnavailableError(f"Imagem de entrada invalida: {e}") from e

                logger.info("[Orchestrator] Encaminhando payload para o ComfyUI (LTX-Video)...")
                await status_manager.set_ltx_video("busy")
                job.file_path = await generate_video_with_guard(
                    self.video,
                    positive_prompt=job.refined_prompt,
                    negative_prompt=NEGATIVE_PROMPT_DEFAULT,
                    image_bytes=image_bytes,
                    seed=job.request.seed if job.request is not None else None,
                )
                await status_manager.set_ltx_video("ready")
            elif job.kind == "3d":
                if self.mesh is None:
                    raise ProviderUnavailableError(
                        "Job 3D recebido, mas nenhum ThreeDProvider foi injetado no "
                        "orchestrator (confira a instanciacao de ComfyUI3DProvider em app/main.py)."
                    )
                job.status = JobStatus.GENERATING_3D

                try:
                    image_bytes = resize_image_b64(
                        job.request.input_image_base64, settings.COMFYUI_3D_INPUT_IMAGE_MAX_SIDE
                    )
                except InvalidImageError as e:
                    raise ProviderUnavailableError(f"Imagem de entrada invalida: {e}") from e

                logger.info("[Orchestrator] Encaminhando imagem para o ComfyUI (Hunyuan3D)...")
                await status_manager.set_comfyui_3d("busy")
                job.file_path = await generate_mesh_with_guard(
                    self.mesh,
                    image_bytes=image_bytes,
                    seed=job.request.seed if job.request is not None else None,
                    export_format=job.request.export_format if job.request is not None else "glb",
                )
                await status_manager.set_comfyui_3d("ready")
            elif job.kind == "audio":
                if job.request is None:
                    raise ProviderUnavailableError("Request de dublagem ausente no job.")

                strategy = self._select_dubbing_strategy(job.request)
                if strategy is None:
                    raise ProviderUnavailableError(
                        f"Job de áudio (dubbing_mode={getattr(job.request, 'dubbing_mode', '?')!r}) "
                        "recebido, mas nenhum provider correspondente foi injetado no orchestrator."
                    )

                job.status = JobStatus.GENERATING_AUDIO
                await status_manager.set_dubbing("busy")
                logger.info("[Orchestrator] Encaminhando áudio para %s...", type(strategy).__name__)

                audio_bytes = job.request.file_content if hasattr(job.request, "file_content") else b""
                if not audio_bytes:
                    raise ProviderUnavailableError("Arquivo de áudio indisponível para processamento de dublagem.")

                job.file_path = await strategy.generate(audio_bytes, job.request)
                voice_label = job.request.voice_id if job.request.dubbing_mode == "voice_conversion" else "voz original (clonada)"
                job.refined_prompt = f"Dublagem via {strategy.provider_name} ({job.request.dubbing_mode}) para {voice_label}"
                # O estado real e confirmado no finally (health_check da estrategia usada),
                # em vez de forcar "ready" aqui -- ver bug corrigido abaixo.
            else:
                job.status = JobStatus.GENERATING_IMAGE
                logger.info(
                    "[Orchestrator] Encaminhando prompt para %s (mode=%s)...",
                    type(self.image).__name__,
                    job.request.mode if job.request is not None else "t2i",
                )
                await status_manager.set_fooocus("busy")
                job.file_path = await generate_image_with_guard(self.image, job.refined_prompt, job.request)
                await status_manager.set_fooocus("ready")

            job.status = JobStatus.COMPLETED

        except ResourceExhaustedError as e:
            job.status = JobStatus.FAILED
            job.error = f"VRAM insuficiente mesmo apos retries: {e}"
            logger.error(job.error)
        except ProviderUnavailableError as e:
            job.status = JobStatus.FAILED
            job.error = str(e)
            logger.error(job.error)
        except Exception as e:
            job.status = JobStatus.FAILED
            job.error = f"Erro inesperado: {e}"
            logger.exception("Erro inesperado no pipeline")
        finally:
            # libera o audio da RAM (ate 200 jobs no historico x 15MB+ cada)
            if job.kind == "audio" and job.request is not None and hasattr(job.request, "file_content"):
                job.request.file_content = None
            await status_manager.set_ollama("ready")
            await status_manager.set_fooocus("ready")
            if self.video is not None:
                await status_manager.set_ltx_video("ready")
            if self.mesh is not None:
                await status_manager.set_comfyui_3d("ready")
            if job.kind == "audio":
                # ANTES: forcava set_dubbing("ready") sempre, escondendo um provider
                # offline/401 (ex: chave da ElevenLabs invalida). Agora reflete o
                # health_check() real da estrategia usada neste job.
                strategy = self._select_dubbing_strategy(job.request) if job.request is not None else None
                try:
                    dubbing_ok = await strategy.health_check() if strategy is not None else False
                except Exception:
                    logger.exception("Falha ao checar health_check() da estrategia de dublagem")
                    dubbing_ok = False
                await status_manager.set_dubbing("ready" if dubbing_ok else "offline")
            await status_manager.set_processing(None)

        return job
