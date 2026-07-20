"""
Nucleo da aplicacao (core). Orquestra o pipeline Ollama -> Fooocus
usando o resource_manager para retries. Este arquivo NUNCA precisa
mudar ao trocar de provedor: apenas os objetos injetados no
construtor mudam (Dependency Injection via app/main.py).
"""
import logging
from app.models import Job, JobStatus
from app.providers.base import LLMProvider, ImageProvider, ProviderUnavailableError, ResourceExhaustedError
from app.resource_manager import generate_image_with_guard
from app.status_manager import status_manager

logger = logging.getLogger("nexus.orchestrator")


class NexusOrchestrator:
    def __init__(self, llm_provider: LLMProvider, image_provider: ImageProvider):
        self.llm = llm_provider
        self.image = image_provider

    async def run(self, job: Job) -> Job:
        try:
            await status_manager.set_processing(job.id)

            if not job.refined_prompt:
                job.status = JobStatus.REFINING_PROMPT
                await status_manager.set_ollama("busy")
                job.refined_prompt = await self.llm.refine_prompt(job.user_prompt)
                await status_manager.set_ollama("ready")

            # Libera VRAM do LLM ANTES de acionar o Fooocus. Este e o passo
            # critico para notebooks com VRAM compartilhada (RTX 3050 6GB):
            # nunca deixamos Ollama e Fooocus com peso em memoria ao mesmo tempo.
            job.status = JobStatus.UNLOADING_LLM
            await self.llm.clear_context()

            job.status = JobStatus.GENERATING_IMAGE
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
            await status_manager.set_ollama("ready")
            await status_manager.set_fooocus("ready")
            await status_manager.set_processing(None)

        return job
