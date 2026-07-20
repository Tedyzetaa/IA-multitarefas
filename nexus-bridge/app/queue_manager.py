"""
Fila assincrona interna (asyncio.Queue) com worker unico.
Garante serializacao estrita: um job por vez, LLM e Imagem nunca
disputam VRAM simultaneamente entre jobs diferentes -- e assim que
evitamos o erro classico de 'alloc_tensor' / CUDA OOM em GPUs com
pouca VRAM (RTX 3050 6GB) rodando dois processos pesados.

Para escalar alem de um unico notebook (ex: cluster com Redis),
basta substituir esta classe por uma implementacao usando
`redis` + `arq`/`rq` mantendo a mesma interface publica
(enqueue / get_job / list_jobs), sem tocar no restante do sistema.
"""
import asyncio
import logging
from collections import OrderedDict
from typing import Optional
from app.models import Job
from app.services.orchestrator import NexusOrchestrator
from app.status_manager import status_manager
from app.config import settings

logger = logging.getLogger("nexus.queue_manager")


class QueueManager:
    def __init__(self, orchestrator: NexusOrchestrator):
        self.orchestrator = orchestrator
        self._queue: "asyncio.Queue[str]" = asyncio.Queue()
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._worker_task: Optional[asyncio.Task] = None

    def start(self):
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker_loop())
            logger.info("Worker da fila Nexus-Bridge iniciado.")

    async def enqueue(self, job: Job) -> Job:
        self._jobs[job.id] = job
        self._trim_history()
        await self._queue.put(job.id)
        await status_manager.set_queue_length(self._queue.qsize())
        return job

    def get_job(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list_jobs(self, limit: int = 50):
        return list(self._jobs.values())[-limit:][::-1]

    def _trim_history(self):
        while len(self._jobs) > settings.JOB_HISTORY_LIMIT:
            self._jobs.popitem(last=False)

    async def _worker_loop(self):
        while True:
            job_id = await self._queue.get()
            job = self._jobs.get(job_id)
            await status_manager.set_queue_length(self._queue.qsize())
            if job is None:
                self._queue.task_done()
                continue
            try:
                await self.orchestrator.run(job)
            except Exception:
                logger.exception(f"Falha critica processando job {job_id}")
            finally:
                self._queue.task_done()
