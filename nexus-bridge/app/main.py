import logging
from pathlib import Path

from typing import Optional

import uuid

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.models import (
    DubbingPreviewResponse,
    DubbingRequest,
    DubbingResponse,
    GenerateRequest,
    Job,
    SystemStatus,
    ThreeDGenerateRequest,
    VideoGenerateRequest,
)
from app.providers.comfyui_provider import ComfyUIImageProvider
from app.providers.comfyui_video_provider import ComfyUIVideoProvider
from app.providers.comfyui_3d_provider import ComfyUI3DProvider
from app.providers.dubbing_provider import DubbingProvider
from app.providers.translation_dubbing_provider import TranslationDubbingProvider
from app.providers.ollama_provider import OllamaProvider
from app.providers.base import ProviderUnavailableError, ResourceExhaustedError
from app.queue_manager import QueueManager
from app.resource_manager import get_free_vram_mb
from app.services.orchestrator import NexusOrchestrator
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

# --- Injecao de dependencias: ComfyUI para imagem e video ---
# Pipeline unificado: ComfyUI para T2I/I2I (imagem) e LTX-Video (video).
# Ambos provedores implementam o contrato ImageProvider/VideoProvider
# (app/providers/base.py), entao o orchestrator e o resource_manager
# funcionam identicamente com qualquer backend.
llm_provider = OllamaProvider()
image_provider = ComfyUIImageProvider()  # T2I/I2I via ComfyUI
video_provider = ComfyUIVideoProvider()  # LTX-Video via ComfyUI (aponta para settings.COMFYUI_HOST)
mesh_provider = ComfyUI3DProvider()      # Hunyuan3D (imagem -> malha) via ComfyUI, mesmo host
dubbing_provider = DubbingProvider(
    api_key=settings.ELEVENLABS_API_KEY,
    host=settings.ELEVENLABS_HOST,
    timeout_s=settings.ELEVENLABS_TIMEOUT_S,
)
# translation_dubbing (modo default) reaproveita o MESMO OllamaProvider usado
# no refinamento de prompt de imagem/video -- um so cliente Ollama no processo.
translation_dubbing_provider = TranslationDubbingProvider(llm_provider=llm_provider)
orchestrator = NexusOrchestrator(
    llm_provider, image_provider, video_provider,
    dubbing_provider=dubbing_provider,
    translation_dubbing_provider=translation_dubbing_provider,
    mesh_provider=mesh_provider,
)
queue_manager = QueueManager(orchestrator)

def _default_dubbing_strategy():
    """Estrategia de dublagem usada nos health checks agregados (/api/status, /api/health,
    startup). Reflete settings.DUBBING_DEFAULT_MODE -- um request individual pode escolher
    a outra estrategia via dubbing_mode, mas os health checks agregados mostram o default."""
    if settings.DUBBING_DEFAULT_MODE == "voice_conversion":
        return dubbing_provider
    return translation_dubbing_provider


app.mount("/images", StaticFiles(directory=str(settings.OUTPUT_DIR)), name="images")
app.mount("/videos", StaticFiles(directory=str(settings.OUTPUT_DIR_VIDEOS)), name="videos")
app.mount("/audio", StaticFiles(directory=str(settings.OUTPUT_DIR_AUDIO)), name="audio")
app.mount("/meshes", StaticFiles(directory=str(settings.OUTPUT_DIR_MESHES)), name="meshes")


# --- Exception handlers globais -------------------------------------------
# Cobrem falhas que escapam do try/except interno do orchestrator (ex: erro
# sincrono nos proprios endpoints, ou no enqueue) para que a API nunca derrube
# a conexao com um 500 cru sem contexto.

@app.exception_handler(ProviderUnavailableError)
async def provider_unavailable_handler(request: Request, exc: ProviderUnavailableError):
    logger.warning(f"Provider indisponivel em {request.url.path}: {exc}")
    return JSONResponse(
        status_code=503,
        content={"error": "provider_unavailable", "detail": str(exc)},
    )


@app.exception_handler(ResourceExhaustedError)
async def resource_exhausted_handler(request: Request, exc: ResourceExhaustedError):
    logger.error(f"VRAM/recurso esgotado em {request.url.path}: {exc}")
    return JSONResponse(
        status_code=503,
        content={"error": "resource_exhausted", "detail": str(exc)},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Loga POR QUE o 422 aconteceu (campo ausente, tipo invalido, corpo truncado...)."""
    errors = [
        {"loc": list(e.get("loc", [])), "msg": e.get("msg"), "type": e.get("type")}
        for e in exc.errors()
    ]
    content_length = request.headers.get("content-length")
    logger.error(
        "422 em %s %s | content-type=%s | content-length=%s | erros=%s",
        request.method, request.url.path,
        request.headers.get("content-type", "")[:60], content_length, errors,
    )
    hint = None
    if any(e["loc"][-1:] == ["file"] and e["type"] == "missing" for e in errors):
        hint = (
            "Campo multipart 'file' ausente. Causas: (1) o frontend usa outro nome de campo; "
            "(2) o corpo chegou TRUNCADO (proxy do Next.js limita o body bufferizado a 10MB "
            "quando ha middleware/proxy) -- envie direto ao FastAPI ou aumente "
            "experimental.middlewareClientMaxBodySize / proxyClientMaxBodySize."
        )
    return JSONResponse(status_code=422, content={"error": "validation_error", "detail": errors, "hint": hint})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception(f"Erro nao tratado em {request.url.path}")
    return JSONResponse(
        status_code=500,
        content={"error": "internal_error", "detail": "Erro interno. Verifique os logs do nexus-bridge."},
    )


@app.on_event("startup")
async def startup():
    queue_manager.start()
    ollama_ok = await llm_provider.health_check()
    fooocus_ok = await image_provider.health_check()
    ltx_ok = await video_provider.health_check()
    mesh_ok = await mesh_provider.health_check()
    dubbing_ok = await _default_dubbing_strategy().health_check()
    await status_manager.set_ollama("ready" if ollama_ok else "offline")
    await status_manager.set_fooocus("ready" if fooocus_ok else "offline")
    await status_manager.set_ltx_video("ready" if ltx_ok else "offline")
    await status_manager.set_comfyui_3d("ready" if mesh_ok else "offline")
    await status_manager.set_dubbing("ready" if dubbing_ok else "offline")
    logger.info(
        f"Startup: Ollama={ollama_ok} Fooocus={fooocus_ok} LTX-Video={ltx_ok} "
        f"Hunyuan3D={mesh_ok} Dubbing={dubbing_ok}"
    )
    if not ltx_ok:
        logger.warning(
            f"ComfyUI nao respondeu em {settings.COMFYUI_HOST} -- "
            f"jobs de video vao falhar ate COMFYUI_HOST ser corrigido no .env "
            f"(e o servidor do ComfyUI estiver de pe)."
        )


@app.post("/api/generate", response_model=Job)
async def generate(req: GenerateRequest):
    job = Job(user_prompt=req.user_prompt, request=req)
    if req.skip_refinement:
        job.refined_prompt = req.user_prompt
    await queue_manager.enqueue(job)
    return job


@app.post("/api/generate-video", response_model=Job)
async def generate_video(req: VideoGenerateRequest):
    job = Job(user_prompt=req.user_prompt, request=req, kind="video")
    if req.skip_refinement:
        job.refined_prompt = req.user_prompt
    await queue_manager.enqueue(job)
    return job


@app.post("/api/generate-3d", response_model=Job)
async def generate_3d(req: ThreeDGenerateRequest):
    """Gera uma malha 3D (imagem -> .glb/.fbx) via Hunyuan3D (ComfyUI).

    Sem refinamento de prompt (nao ha campo de texto): a geracao usa so a
    imagem de entrada. export_format="fbx" aciona conversao adicional via
    Blender headless (ver app/providers/mesh_converter.py) -- "glb" (default)
    e o formato nativo do ComfyUI e o Roblox Studio importa ambos igualmente bem.
    """
    job = Job(user_prompt="[image-to-3d]", request=req, kind="3d")
    job.refined_prompt = "[sem refinamento -- pipeline 3D usa somente a imagem de entrada]"
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
    live_ltx = await video_provider.health_check()
    live_mesh = await mesh_provider.health_check()
    live_dubbing = await _default_dubbing_strategy().health_check()
    await status_manager.set_ollama("ready" if live_ollama else "offline")
    await status_manager.set_fooocus("ready" if live_fooocus else "offline")
    await status_manager.set_ltx_video("ready" if live_ltx else "offline")
    await status_manager.set_comfyui_3d("ready" if live_mesh else "offline")
    await status_manager.set_dubbing("ready" if live_dubbing else "offline")
    return await status_manager.snapshot()


@app.get("/api/health")
async def health():
    """
    Health check ativo: nao retorna so um 200 fixo. Verifica de fato se o
    Ollama esta respondendo na porta configurada E se o modelo definido em
    OLLAMA_MODEL esta instalado/pronto, alem do status do Fooocus e da VRAM
    livre no momento. Retorna 503 quando algo essencial esta fora do ar, para
    que qualquer watchdog/orquestrador externo detecte o problema de verdade.
    """
    ollama_ready, ollama_detail = await llm_provider.model_ready()
    fooocus_ok = await image_provider.health_check()
    ltx_ok = await video_provider.health_check()
    mesh_ok = await mesh_provider.health_check()
    dubbing_ok = await _default_dubbing_strategy().health_check()
    free_vram = get_free_vram_mb()

    # LTX-Video e o pipeline 3D ficam FORA do overall_ok de proposito: sao
    # recursos opcionais, o pipeline de imagem (Ollama+Fooocus) deve
    # continuar reportando "ok" mesmo se COMFYUI_HOST estiver mal configurado.
    overall_ok = ollama_ready and fooocus_ok

    return JSONResponse(
        status_code=200 if overall_ok else 503,
        content={
            "status": "ok" if overall_ok else "degraded",
            "service": "nexus-bridge",
            "ollama": {"ready": ollama_ready, "detail": ollama_detail},
            "fooocus": {"ready": fooocus_ok},
            "ltx_video": {"ready": ltx_ok},
            "comfyui_3d": {"ready": mesh_ok},
            "dubbing": {"ready": dubbing_ok},
            "vram_free_mb": free_vram,
        },
    )


@app.post("/api/v1/dubbing/process", response_model=DubbingResponse)
async def process_dubbing(
    file: UploadFile = File(...),
    dubbing_mode: Optional[str] = Form(None),
    source_language: Optional[str] = Form("en"),
    target_language: Optional[str] = Form("pt-BR"),
    provider: Optional[str] = Form("elevenlabs"),
    voice_id: Optional[str] = Form(None),
    model_id: Optional[str] = Form(None),
    language_code: Optional[str] = Form(None),
    stability: float = Form(0.5),
    similarity_boost: float = Form(0.75),
    style: float = Form(0.0),
    speaker_boost: bool = Form(True),
    output_format: str = Form("mp3"),
):
    """Endpoint de dublagem com upload de áudio.

    dubbing_mode escolhe a estratégia (default: settings.DUBBING_DEFAULT_MODE =
    "translation_dubbing" -- preserva a voz original e TRADUZ o áudio via pipeline
    local whisper->Ollama->XTTS v2). "voice_conversion" usa o Speech-to-Speech da
    ElevenLabs (troca a voz, NÃO traduz) e nesse caso voice_id é obrigatório.

    Arquivos >= DUBBING_BACKGROUND_THRESHOLD_BYTES vão para a fila (retorna job_id para polling
    em /api/jobs/{job_id}); menores são processados de forma síncrona.
    """
    # Captura TUDO aqui: um 500 vindo do handler global (ServerErrorMiddleware) fica fora do
    # CORSMiddleware e, num fetch direto do browser, vira "Failed to fetch" sem mensagem.
    # HTTPException passa pelo CORS e chega ao cliente com o corpo JSON legível.
    try:
        resolved_mode = (dubbing_mode or settings.DUBBING_DEFAULT_MODE or "translation_dubbing").strip()
        if resolved_mode not in {"voice_conversion", "translation_dubbing"}:
            raise HTTPException(
                status_code=400,
                detail=f"dubbing_mode inválido: {resolved_mode!r}. Use 'voice_conversion' ou 'translation_dubbing'.",
            )

        voice_id = (voice_id or "").strip() or settings.ELEVENLABS_DEFAULT_VOICE_ID.strip()
        if resolved_mode == "voice_conversion" and not voice_id:
            raise HTTPException(
                status_code=400,
                detail="Informe o voice_id da ElevenLabs (campo 'voice_id') ou defina "
                       "ELEVENLABS_DEFAULT_VOICE_ID no .env do nexus-bridge (obrigatório "
                       "apenas em dubbing_mode='voice_conversion').",
            )

        name = (file.filename or "audio").lower()
        suffix = Path(name).suffix.lstrip(".").lower()
        if suffix not in {"wav", "mp3", "m4a"}:
            raise HTTPException(status_code=400, detail="Formato de áudio inválido. Envie WAV, MP3 ou M4A.")

        raw_audio = await file.read()
        if not raw_audio:
            raise HTTPException(status_code=400, detail="Arquivo de áudio vazio.")
        logger.info("Dublagem: recebido %s (%.1f MB), voice_id=%s", file.filename, len(raw_audio) / 1e6, voice_id)

        try:
            request = DubbingRequest(
                dubbing_mode=resolved_mode,
                voice_id=voice_id or None,
                file_name=file.filename or name,
                format=suffix,
                output_format=output_format.lower(),
                model_id=model_id or settings.ELEVENLABS_DEFAULT_MODEL,
                provider=provider or "elevenlabs",
                source_language=source_language,
                target_language=target_language,
                language_code=language_code,
                file_content=raw_audio,
                voice_settings={
                    "stability": stability,
                    "similarity_boost": similarity_boost,
                    "style": style,
                    "speaker_boost": speaker_boost,
                },
            )
        except ValueError as exc:  # pydantic.ValidationError herda de ValueError
            raise HTTPException(status_code=422, detail=f"Parâmetros de dublagem inválidos: {exc}") from exc

        job_label = voice_id if resolved_mode == "voice_conversion" else "voz original (traduzido)"
        if len(raw_audio) >= settings.DUBBING_BACKGROUND_THRESHOLD_BYTES:
            job = Job(user_prompt=f"Dublagem ({resolved_mode}) para {job_label}", request=request, kind="audio")
            await queue_manager.enqueue(job)
            return DubbingResponse(
                job_id=job.id,
                provider=request.provider,
                output_format=request.output_format,
                message="Arquivo em processamento em background. Consulte o job em /api/jobs/{job_id}.",
                voice_id=request.voice_id or "",
            )

        strategy = dubbing_provider if resolved_mode == "voice_conversion" else translation_dubbing_provider
        output_path = Path(await strategy.generate(raw_audio, request))
        # translation_dubbing (XTTS v2) sempre grava .wav, independente do output_format
        # pedido -- refletir a extensao REAL do arquivo gerado na resposta.
        actual_format = output_path.suffix.lstrip(".").lower() or request.output_format
        return DubbingResponse(
            job_id=str(uuid.uuid4()),
            provider=request.provider,
            output_format=actual_format if actual_format in {"wav", "mp3", "m4a"} else request.output_format,
            file_path=str(output_path),
            audio_url=f"/audio/{output_path.name}",
            message="Dublagem concluída com sucesso.",
            voice_id=request.voice_id or "",
            bytes_written=output_path.stat().st_size,
        )

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except ProviderUnavailableError as exc:
        logger.error("Dublagem indisponível: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Erro ao processar dublagem")
        raise HTTPException(status_code=500, detail=f"Erro interno ao processar a dublagem: {exc!r}") from exc


@app.post("/api/v1/dubbing/preview", response_model=DubbingPreviewResponse)
async def dubbing_preview(
    file: UploadFile = File(...),
    source_language: Optional[str] = Form("en"),
    target_language: Optional[str] = Form("pt-BR"),
):
    """Passo 1 do fluxo revisável de translation_dubbing: transcreve (whisper) e
    traduz (Ollama), mas NÃO sintetiza ainda. Devolve translated_text para o
    usuário corrigir na caixa de texto do frontend antes de confirmar a síntese
    em POST /api/v1/dubbing/synthesize (usando o session_id retornado aqui).

    Só cobre o modo translation_dubbing (voz clonada) -- voice_conversion
    continua usando /api/v1/dubbing/process normalmente.
    """
    try:
        name = (file.filename or "audio").lower()
        suffix = Path(name).suffix.lstrip(".").lower()
        if suffix not in {"wav", "mp3", "m4a"}:
            raise HTTPException(status_code=400, detail="Formato de áudio inválido. Envie WAV, MP3 ou M4A.")

        raw_audio = await file.read()
        if not raw_audio:
            raise HTTPException(status_code=400, detail="Arquivo de áudio vazio.")
        logger.info("Dublagem (preview): recebido %s (%.1f MB)", file.filename, len(raw_audio) / 1e6)

        result = await translation_dubbing_provider.create_preview(
            raw_audio, suffix, source_language, target_language
        )
        return DubbingPreviewResponse(**result, expires_in_seconds=1800)

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderUnavailableError as exc:
        logger.error("Preview de dublagem indisponível: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Erro ao gerar preview de dublagem")
        raise HTTPException(status_code=500, detail=f"Erro interno ao gerar o preview: {exc!r}") from exc


@app.post("/api/v1/dubbing/synthesize", response_model=DubbingResponse)
async def dubbing_synthesize(
    session_id: str = Form(...),
    translated_text: str = Form(...),
    target_language: Optional[str] = Form(None),
    reference_voice: Optional[UploadFile] = File(None),
):
    """Passo 2 do fluxo revisável: sintetiza translated_text (já revisado/corrigido
    pelo usuário no frontend) com XTTS v2, usando session_id devolvido por
    POST /api/v1/dubbing/preview.

    reference_voice é OPCIONAL: se enviado, clona essa voz; se vazio/ausente,
    clona a voz do próprio áudio original enviado no passo 1.
    """
    try:
        ref_bytes: Optional[bytes] = None
        ref_suffix: Optional[str] = None
        if reference_voice is not None and (reference_voice.filename or "").strip():
            ref_name = reference_voice.filename.lower()
            ref_suffix = Path(ref_name).suffix.lstrip(".").lower() or "wav"
            if ref_suffix not in {"wav", "mp3", "m4a"}:
                raise HTTPException(
                    status_code=400,
                    detail="Formato da voz de referência inválido. Envie WAV, MP3 ou M4A.",
                )
            body = await reference_voice.read()
            ref_bytes = body or None  # arquivo enviado vazio == tratar como "não enviado"

        output_path = Path(await translation_dubbing_provider.synthesize_from_preview(
            session_id, translated_text, target_language, ref_bytes, ref_suffix
        ))
        actual_format = output_path.suffix.lstrip(".").lower() or "wav"
        return DubbingResponse(
            job_id=str(uuid.uuid4()),
            provider="local_flow_matching",
            output_format=actual_format if actual_format in {"wav", "mp3", "m4a"} else "wav",
            file_path=str(output_path),
            audio_url=f"/audio/{output_path.name}",
            message="Dublagem concluída com sucesso.",
            voice_id="",
            bytes_written=output_path.stat().st_size,
        )

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderUnavailableError as exc:
        logger.error("Síntese de dublagem indisponível: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Erro ao sintetizar dublagem")
        raise HTTPException(status_code=500, detail=f"Erro interno ao sintetizar: {exc!r}") from exc
