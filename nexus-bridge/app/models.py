from enum import Enum
from typing import Optional, Literal
from pydantic import BaseModel, Field
from datetime import datetime
import uuid


class JobStatus(str, Enum):
    QUEUED = "queued"
    REFINING_PROMPT = "refining_prompt"
    UNLOADING_LLM = "unloading_llm"
    GENERATING_IMAGE = "generating_image"
    COMPLETED = "completed"
    FAILED = "failed"


# --- Sub-schemas para recursos avancados nativos do Fooocus ---
# Espelham 1:1 os campos que modules/async_worker.py::AsyncTask.__init__
# consome (ver ordem exata em fooocus_gradio_provider.py::build_ctrls).

class LoraItem(BaseModel):
    enabled: bool = True
    name: str = "None"          # nome do arquivo em models/loras, ou "None"
    weight: float = Field(1.0, ge=-2.0, le=2.0)


class ImagePromptItem(BaseModel):
    """Um slot de Image Prompt / ControlNet (Fooocus permite ate 4)."""
    image_base64: str                       # imagem de referencia, base64 (sem prefixo data:)
    stop_at: float = Field(0.5, ge=0.0, le=1.0)
    weight: float = Field(0.6, ge=0.0, le=2.0)
    type: Literal["ImagePrompt", "PyraCanny", "CPDS", "FaceSwap"] = "ImagePrompt"


class InpaintParams(BaseModel):
    input_image_base64: str                 # imagem base a ser editada, base64
    mask_base64: Optional[str] = None        # mascara manual opcional (branco = area editavel)
    additional_prompt: Optional[str] = None
    strength: float = Field(1.0, ge=0.0, le=1.0)
    respective_field: float = Field(0.618, ge=0.0, le=1.0)
    engine: str = "v2.6"


class OutpaintParams(BaseModel):
    input_image_base64: str
    directions: list[Literal["Left", "Right", "Top", "Bottom"]] = Field(default_factory=list)


class UpscaleVaryParams(BaseModel):
    input_image_base64: str
    method: Literal[
        "Vary (Subtle)", "Vary (Strong)",
        "Upscale (1.5x)", "Upscale (2x)", "Upscale (Fast 2x)",
    ] = "Upscale (2x)"


class GenerateRequest(BaseModel):
    user_prompt: str = Field(..., min_length=2, max_length=2000)
    skip_refinement: bool = False

    # --- Essenciais (negative prompt, styles, seed, CFG, sharpness) ---
    negative_prompt: str = ""
    style_selections: list[str] = Field(default_factory=lambda: ["Fooocus Enhance", "Fooocus Sharp"])
    seed: Optional[int] = None              # None = aleatorio
    guidance_scale: Optional[float] = None  # None = default do Fooocus (7.0)
    sharpness: Optional[float] = None       # None = default do Fooocus (2.0)

    # --- Modelos e LoRAs ---
    base_model_name: Optional[str] = None
    refiner_model_name: Optional[str] = None
    refiner_switch: Optional[float] = None
    loras: list[LoraItem] = Field(default_factory=list)

    # --- Image Prompt / ControlNet ---
    image_prompts: list[ImagePromptItem] = Field(default_factory=list)

    # --- Edicao de imagem (mutuamente exclusivos entre si e com image_prompts "sozinho") ---
    inpaint: Optional[InpaintParams] = None
    outpaint: Optional[OutpaintParams] = None
    upscale_vary: Optional[UpscaleVaryParams] = None


class Job(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_prompt: str
    refined_prompt: Optional[str] = None
    status: JobStatus = JobStatus.QUEUED
    file_path: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    retries: int = 0

    # snapshot dos parametros avancados usados nesse job (audit trail)
    request: Optional[GenerateRequest] = None


class SystemStatus(BaseModel):
    ollama: str
    fooocus: str
    queue_length: int
    processing_job_id: Optional[str] = None
