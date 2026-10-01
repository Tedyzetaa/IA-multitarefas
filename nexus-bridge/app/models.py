from enum import Enum
from typing import Optional, Literal
from pydantic import BaseModel, Field, model_validator
from datetime import datetime
import uuid


class JobStatus(str, Enum):
    QUEUED = "queued"
    REFINING_PROMPT = "refining_prompt"
    UNLOADING_LLM = "unloading_llm"
    GENERATING_IMAGE = "generating_image"
    GENERATING_VIDEO = "generating_video"
    GENERATING_AUDIO = "generating_audio"
    GENERATING_3D = "generating_3d"
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


class VoiceSettings(BaseModel):
    """Configuração de prosódia/entonação para dublagem expressiva."""
    stability: float = Field(0.5, ge=0.0, le=1.0)
    similarity_boost: float = Field(0.75, ge=0.0, le=1.0)
    style: float = Field(0.0, ge=0.0, le=1.0)
    speaker_boost: bool = True


class DubbingRequest(BaseModel):
    """Requisição do fluxo de dublagem.

    dubbing_mode escolhe a ESTRATÉGIA:
    - "translation_dubbing" (default): preserva a voz original do falante e
      TRADUZ o áudio (pipeline local: faster-whisper -> Ollama -> XTTS v2).
      voice_id não é usado nesse modo.
    - "voice_conversion": Speech-to-Speech da ElevenLabs (troca a voz, NÃO
      traduz). Requer voice_id.
    """
    dubbing_mode: Literal["voice_conversion", "translation_dubbing"] = "translation_dubbing"
    voice_id: Optional[str] = Field(default=None, min_length=3, max_length=200)
    file_name: Optional[str] = None
    format: Literal["wav", "mp3", "m4a"] = "wav"
    output_format: Literal["wav", "mp3", "m4a"] = "mp3"
    model_id: str = "eleven_multilingual_v2"
    provider: Literal["elevenlabs", "local_flow_matching"] = "elevenlabs"
    # Idioma de origem do audio (usado pelo whisper no modo translation_dubbing).
    source_language: Optional[str] = "en"
    target_language: Optional[str] = None
    language_code: Optional[str] = None
    # exclude=True: os bytes do audio NUNCA entram na serializacao do Job
    # (GET /api/jobs/{id}, /api/gallery). Sem isso, response_model=Job tenta
    # converter ate 15MB+ de audio binario para JSON/UTF-8 e estoura em 500.
    file_content: Optional[bytes] = Field(default=None, exclude=True, repr=False)
    voice_settings: VoiceSettings = Field(default_factory=VoiceSettings)

    @model_validator(mode="after")
    def validate_format(self):
        if self.dubbing_mode == "voice_conversion" and not (self.voice_id or "").strip():
            raise ValueError("voice_id é obrigatório quando dubbing_mode='voice_conversion'.")
        if self.file_name:
            suffix = self.file_name.rsplit(".", 1)[-1].lower()
            if suffix and suffix not in {"wav", "mp3", "m4a"}:
                raise ValueError("file_name deve apontar para um arquivo WAV, MP3 ou M4A.")
        if self.format not in {"wav", "mp3", "m4a"}:
            raise ValueError("format deve ser 'wav', 'mp3' ou 'm4a'.")
        if self.output_format not in {"wav", "mp3", "m4a"}:
            raise ValueError("output_format deve ser 'wav', 'mp3' ou 'm4a'.")
        return self


class DubbingPreviewResponse(BaseModel):
    """Resposta do passo 1 (POST /api/v1/dubbing/preview): transcrição + tradução
    para o usuário revisar/corrigir na caixa de texto antes de sintetizar (passo 2,
    POST /api/v1/dubbing/synthesize)."""
    session_id: str
    transcript: str
    translated_text: str
    source_language: str
    target_language: str
    expires_in_seconds: int


class DubbingResponse(BaseModel):
    """Resposta de sucesso para o endpoint de dublagem."""
    job_id: str
    provider: str
    output_format: Literal["wav", "mp3", "m4a"]
    file_path: Optional[str] = None
    audio_url: Optional[str] = None
    message: str = "Dublagem concluída com sucesso."
    voice_id: str
    bytes_written: Optional[int] = None


class GenerateRequest(BaseModel):
    user_prompt: str = Field(..., min_length=2, max_length=2000)
    skip_refinement: bool = False

    # --- Modo de geracao (so tem efeito quando IMAGE_PROVIDER=comfyui;
    # ignorado pelo FooocusGradioProvider) ---
    # "t2i" = texto->imagem (app/workflows/comfyui_t2i_api.json)
    # "i2i" = imagem->imagem (app/workflows/comfyui_i2i_api.json), requer image_base64
    mode: Literal["t2i", "i2i"] = "t2i"
    # Imagem de entrada para o modo i2i. Aceita base64 puro OU uma data URI
    # completa ("data:image/jpeg;base64,..."); o provider remove o prefixo
    # se presente (ver ComfyUIImageProvider._decode_base64_image).
    image_base64: Optional[str] = None

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

    @model_validator(mode="after")
    def validate_i2i_requires_image(self):
        # Falha rapido com 422 (erro de validacao claro do FastAPI) em vez
        # de deixar o ComfyUIImageProvider descobrir isso so depois de
        # refinar o prompt no Ollama e liberar o slot da fila.
        if self.mode == "i2i" and not (self.image_base64 and self.image_base64.strip()):
            raise ValueError("mode='i2i' requer o campo 'image_base64' preenchido.")
        return self


class VideoGenerateRequest(BaseModel):
    """Requisicao de geracao de video via LTX-Video (ComfyUI, image-to-video)."""
    user_prompt: str = Field(..., min_length=2, max_length=2000)
    skip_refinement: bool = False
    seed: Optional[int] = None

    # Imagem de entrada obrigatoria (o pipeline atual e image-to-video).
    # Base64 puro, sem prefixo "data:image/...;base64,". O orchestrator
    # sempre a redimensiona para no maximo settings.LTX_INPUT_IMAGE_MAX_SIDE
    # px antes de envia-la ao ComfyUI (ver app/image_utils.py).
    input_image_base64: str = Field(..., min_length=10)

    # NOTA: nao ha campos de negative_prompt, width, height nem num_frames
    # aqui de proposito. Sao parametros RIGIDOS definidos em config.py
    # (NEGATIVE_PROMPT_DEFAULT em app/constants.py; LTX_WIDTH/HEIGHT/LENGTH/
    # DENOISE em config.py) -- o cliente nunca os controla, exatamente para
    # que o pipeline nao dependa do usuario digitar isso corretamente e para
    # blindar a VRAM disponivel (RTX 3050 6GB). Ver app/services/orchestrator.py.


class ThreeDGenerateRequest(BaseModel):
    """Requisicao de geracao 3D (imagem -> malha) via Hunyuan3D 2.0 (ComfyUI).

    Pipeline atual gera SO geometria (sem textura/PBR) -- ver docstring de
    app/providers/comfyui_3d_provider.py. Nao ha campo de texto/prompt:
    o Hunyuan3D-DiT usa somente o CLIP vision embedding da imagem de
    entrada, nao um prompt textual.
    """
    # Imagem de entrada obrigatoria. Aceita base64 puro OU data URI
    # completa ("data:image/...;base64,...") -- mesmo tratamento usado em
    # GenerateRequest.image_base64 (ver ComfyUIImageProvider._decode_base64_image).
    input_image_base64: str = Field(..., min_length=10)
    seed: Optional[int] = None  # None = aleatorio
    # "glb": formato nativo do ComfyUI (recomendado -- Roblox Studio importa
    # .glb com o MESMO suporte de .fbx, ver mesh_converter.py). "fbx":
    # aciona conversao adicional via Blender headless (requer Blender
    # instalado no host, ver BLENDER_EXECUTABLE em config.py).
    export_format: Literal["glb", "fbx"] = "glb"
    # Nivel de detalhe da malha (VAEDecodeHunyuan3D.octree_resolution).
    # None = usa settings.COMFYUI_3D_OCTREE_RESOLUTION (default 256).
    octree_resolution: Optional[int] = Field(default=None, ge=64, le=512)


class Job(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    kind: Literal["image", "video", "audio", "3d"] = "image"
    user_prompt: str
    refined_prompt: Optional[str] = None
    status: JobStatus = JobStatus.QUEUED
    file_path: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    retries: int = 0

    # snapshot dos parametros usados nesse job (audit trail) -- imagem, video, audio ou 3d
    request: Optional[GenerateRequest | VideoGenerateRequest | DubbingRequest | ThreeDGenerateRequest] = None


class SystemStatus(BaseModel):
    ollama: str
    fooocus: str
    ltx_video: str
    dubbing: str = "idle"
    comfyui_3d: str = "idle"
    queue_length: int
    processing_job_id: Optional[str] = None
