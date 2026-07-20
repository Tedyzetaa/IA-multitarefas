import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.models import GenerateRequest, Job, SystemStatus
from app.providers.ollama_provider import OllamaProvider
from app.providers.fooocus_gradio_provider import FooocusGradioProvider
from app.services.orchestrator import NexusOrchestrator
from app.queue_manager import QueueManager
from app.status_manager import status_manager

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger("nexus.main")

app = FastAPI(title="Nexus-Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Injecao de dependencias: trocar provedor = trocar estas linhas ---
llm_provider = OllamaProvider()
image_provider = FooocusGradioProvider()
orchestrator = NexusOrchestrator(llm_provider, image_provider)
queue_manager = QueueManager(orchestrator)

app.mount("/images", StaticFiles(directory=str(settings.OUTPUT_DIR)), name="images")


@app.on_event("startup")
async def startup():
    queue_manager.start()
    ollama_ok = await llm_provider.health_check()
    fooocus_ok = await image_provider.health_check()
    await status_manager.set_ollama("ready" if ollama_ok else "offline")
    await status_manager.set_fooocus("ready" if fooocus_ok else "offline")
    logger.info(f"Startup: Ollama={ollama_ok} Fooocus={fooocus_ok}")


@app.post("/api/generate", response_model=Job)
async def generate(req: GenerateRequest):
    job = Job(user_prompt=req.user_prompt, request=req)
    if req.skip_refinement:
        job.refined_prompt = req.user_prompt
    await queue_manager.enqueue(job)
    return job


@app.get("/api/jobs/{job_id}", response_model=Job)
async def get_job(job_id: str):
    job = queue_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job nao encontrado")
    return job


@app.get("/api/gallery", response_model=list[Job])
async def gallery(offset: int = 0, limit: int = 20):
    all_jobs = queue_manager.list_jobs(limit=9999)
    completed = [j for j in all_jobs if j.status == "completed"]
    return completed[offset: offset + limit]


@app.get("/api/status", response_model=SystemStatus)
async def status():
    live_ollama = await llm_provider.health_check()
    live_fooocus = await image_provider.health_check()
    await status_manager.set_ollama("ready" if live_ollama else "offline")
    await status_manager.set_fooocus("ready" if live_fooocus else "offline")
    return await status_manager.snapshot()


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "nexus-bridge"}
