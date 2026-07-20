import asyncio
import httpx
from app.config import settings
from app.providers.base import ImageProvider, ResourceExhaustedError, ProviderUnavailableError

OOM_SIGNATURES = (
    "cuda out of memory",
    "cuda error",
    "outofmemoryerror",
    "not enough memory",
    "alloc_tensor",
)


class FooocusProvider(ImageProvider):
    def __init__(self, host: str = None):
        self.host = host or settings.FOOOCUS_HOST

    async def generate(self, prompt: str, steps: int, resolution: str) -> str:
        payload = {
            "prompt": prompt,
            "async_process": True,
            "performance_selection": "Speed",
            "aspect_ratios_selection": resolution,
            "image_number": 1,
            "steps": steps,
        }
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{self.host}/v1/generation/text-to-image",
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"Fooocus indisponivel: {e}") from e

        body_text = resp.text.lower()
        if resp.status_code != 200:
            if any(sig in body_text for sig in OOM_SIGNATURES):
                raise ResourceExhaustedError(f"Fooocus OOM: {resp.text[:200]}")
            raise ProviderUnavailableError(f"Fooocus erro HTTP {resp.status_code}: {resp.text[:200]}")

        data = resp.json()
        job_id = data[0]["job_id"] if isinstance(data, list) else data.get("job_id")
        if not job_id:
            raise ProviderUnavailableError("Fooocus nao retornou job_id")

        return await self._poll_job(job_id)

    async def _poll_job(self, job_id: str, timeout_s: int = 300) -> str:
        elapsed = 0
        interval = 3
        async with httpx.AsyncClient(timeout=15) as client:
            while elapsed < timeout_s:
                resp = await client.get(f"{self.host}/v1/generation/query-job", params={"job_id": job_id})
                data = resp.json()
                status = data.get("job_stage") or data.get("job_status")

                if str(status).lower() in ("success", "finished"):
                    result = data.get("job_result")
                    if result and len(result) > 0:
                        return result[0].get("url") or result[0].get("path")
                    raise ProviderUnavailableError("Job Fooocus concluido sem resultado")

                if str(status).lower() in ("error", "failed"):
                    error_msg = str(data.get("job_step_preview", "")).lower()
                    if any(sig in error_msg for sig in OOM_SIGNATURES):
                        raise ResourceExhaustedError(f"Fooocus OOM durante job {job_id}")
                    raise ProviderUnavailableError(f"Job Fooocus falhou: {data}")

                await asyncio.sleep(interval)
                elapsed += interval

        raise ProviderUnavailableError(f"Timeout aguardando job Fooocus {job_id}")

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.host}/v1/generation/job-queue")
                return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException):
            return False
