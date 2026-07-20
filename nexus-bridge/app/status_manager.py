import asyncio
from typing import Optional
from app.models import SystemStatus


class StatusManager:
    """Estado compartilhado, thread-safe via asyncio, consultado pelo frontend."""

    def __init__(self):
        self._lock = asyncio.Lock()
        self.ollama_status = "unknown"
        self.fooocus_status = "unknown"
        self.queue_length = 0
        self.processing_job_id: Optional[str] = None

    async def set_ollama(self, status: str):
        async with self._lock:
            self.ollama_status = status

    async def set_fooocus(self, status: str):
        async with self._lock:
            self.fooocus_status = status

    async def set_queue_length(self, n: int):
        async with self._lock:
            self.queue_length = n

    async def set_processing(self, job_id):
        async with self._lock:
            self.processing_job_id = job_id

    async def snapshot(self) -> SystemStatus:
        async with self._lock:
            return SystemStatus(
                ollama=self.ollama_status,
                fooocus=self.fooocus_status,
                queue_length=self.queue_length,
                processing_job_id=self.processing_job_id,
            )


status_manager = StatusManager()
