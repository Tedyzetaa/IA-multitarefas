"""
Configuração centralizada do Nexus-Bridge.
Todos os parâmetros sensíveis a hardware ficam aqui, permitindo
ajuste rápido para diferentes GPUs/CPUs sem tocar no core.
"""
from typing import Annotated

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from pathlib import Path


class Settings(BaseSettings):
    # --- Ollama (LLM) ---
    OLLAMA_HOST: str = "http://127.0.0.1:11434"
    OLLAMA_MODEL: str = "qwen2.5-coder:7b"
    OLLAMA_KEEP_ALIVE_ACTIVE: str = "5m"   # tempo que o modelo fica em VRAM durante uso
    OLLAMA_KEEP_ALIVE_IDLE: str = "0"      # 0 = descarrega o modelo imediatamente apos uso
    OLLAMA_NUM_CTX: int = 2048             # contexto fixo para refinamento de prompt (evita estouro de VRAM)

    # --- Fooocus (Imagem) ---
    # Fooocus nativo (webui.py/Gradio) rodando no container Docker oficial --
    # nao ha API REST, a integracao usa gradio_client (ver fooocus_gradio_provider.py).
    FOOOCUS_HOST: str = "http://127.0.0.1:7865"
    FOOOCUS_DEFAULT_STEPS: int = 30
    FOOOCUS_FALLBACK_STEPS: int = 15               # usado em retry apos OOM
    FOOOCUS_DEFAULT_RESOLUTION: str = "1152*896"
    FOOOCUS_FALLBACK_RESOLUTION: str = "896*640"   # resolucao reduzida em retry apos OOM

    # Nome do endpoint Gradio descoberto via tools/discover_fooocus_api.py.
    # Deixe em branco para o provider tentar a lista de candidatos automaticamente.
    FOOOCUS_API_NAME: str = ""

    # Defaults usados quando o request nao especifica (equivalentes aos defaults
    # de fabrica do Fooocus em modules/config.py -- ajuste se seu config.txt
    # ou variaveis de ambiente do container definirem outros modelos).
    # ATENCAO: "model.safetensors" e so o default generico de fabrica do
    # Fooocus (modules/config.py). Confira o nome real do seu checkpoint em
    # config.txt / models/checkpoints dentro do volume do container e ajuste.
    FOOOCUS_BASE_MODEL: str = "model.safetensors"
    FOOOCUS_SAMPLER: str = "dpmpp_2m_sde_gpu"
    FOOOCUS_SCHEDULER: str = "karras"

    # --- Selecao do provider de imagem ---
    # "fooocus" (default, comportamento atual) ou "comfyui" (novo pipeline
    # T2I/I2I via SDXL/Pony Diffusion, ver app/providers/comfyui_provider.py).
    # Trocar aqui NAO exige mudar app/main.py nem o orchestrator.
    IMAGE_PROVIDER: str = "fooocus"

    # --- ComfyUI (Imagem - T2I/I2I via SDXL/Pony Diffusion) ---
    # So relevante quando IMAGE_PROVIDER=comfyui. Reaproveita COMFYUI_HOST/
    # COMFYUI_POLL_INTERVAL_S/COMFYUI_TIMEOUT_S definidos abaixo (mesmo
    # servidor ComfyUI usado pelo pipeline de video).
    COMFYUI_T2I_WORKFLOW_PATH: Path = Path("app/workflows/comfyui_t2i_api.json")
    COMFYUI_I2I_WORKFLOW_PATH: Path = Path("app/workflows/comfyui_i2i_api.json")
    COMFYUI_I2I_DENOISE: float = 0.3   # preserva a estrutura da imagem de entrada (baixo = mais fiel ao original)
    COMFYUI_DEFAULT_LORA_NAME: str = ""  # vazio = usa o lora ja fixado no workflow.json exportado
    COMFYUI_DEFAULT_NEGATIVE_PROMPT: str = "worst quality, low quality, anime, cartoon, deformed"

    # --- ComfyUI (Video - LTX-Video) ---
    # ComfyUI roda como servidor HTTP (diferente do antigo subprocesso que
    # chamava inference.py direto) -- suba com `python main.py --listen`
    # (ou o entrypoint do seu setup) e aponte COMFYUI_HOST pra ele.
    COMFYUI_HOST: str = "http://127.0.0.1:8188"

    # Workflow exportado do ComfyUI em formato API (menu "Workflow > Export
    # (API Format)"). O provider edita este grafo em runtime localizando os
    # nos pelo campo _meta.title -- ver app/workflows/ltxv_i2v_api.json
    # (arquivo de referencia incluso) e o dict _NODE_TITLES em
    # app/providers/comfyui_video_provider.py.
    COMFYUI_WORKFLOW_PATH: Path = Path("app/workflows/ltxv_i2v_api.json")

    COMFYUI_POLL_INTERVAL_S: float = 2.0
    COMFYUI_TIMEOUT_S: int = 600  # 10min -- LTX-Video numa 3050 6GB pode demorar

    # --- ComfyUI (3D - Hunyuan3D 2.0, imagem -> malha) ---
    # Pipeline NATIVO do ComfyUI-Core (sem custom node packs), so gera
    # GEOMETRIA (sem textura/PBR -- ver docstring de
    # app/providers/comfyui_3d_provider.py). Reaproveita COMFYUI_HOST/
    # COMFYUI_POLL_INTERVAL_S/COMFYUI_TIMEOUT_S acima (mesmo servidor
    # ComfyUI usado pelos pipelines de imagem/video).
    COMFYUI_3D_WORKFLOW_PATH: Path = Path("app/workflows/hunyuan3d_i2mesh_api.json")
    # Checkpoint unico (repackaged) que combina MODEL+CLIP_VISION+VAE --
    # baixar de https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged/resolve/main/split_files/hunyuan3d-dit-v2_fp16.safetensors
    # e salvar em ComfyUI/models/checkpoints/.
    COMFYUI_3D_CKPT_NAME: str = "hunyuan3d-dit-v2_fp16.safetensors"
    COMFYUI_3D_STEPS: int = 20     # KSampler -- 20 e o default do template oficial
    COMFYUI_3D_CFG: float = 8.0    # entre 4 e 8 (nota do proprio template oficial)
    COMFYUI_3D_OCTREE_RESOLUTION: int = 256  # detalhe da malha (VAEDecodeHunyuan3D); maior = mais VRAM/tempo
    COMFYUI_3D_OCTREE_RESOLUTION_FALLBACK: int = 128  # usado em retry apos OOM
    COMFYUI_3D_NUM_CHUNKS: int = 8000
    COMFYUI_3D_INPUT_IMAGE_MAX_SIDE: int = 1024  # teto de redimensionamento da imagem de entrada

    # --- Conversao de malha GLB -> FBX (opcional, via Blender headless) ---
    # So usada quando ThreeDGenerateRequest.export_format="fbx". Roblox
    # Studio importa .glb nativamente com o mesmo suporte de .fbx -- ver
    # docstring de app/providers/mesh_converter.py antes de habilitar.
    BLENDER_EXECUTABLE: str = "blender"  # ajuste para o caminho completo se nao estiver no PATH
    BLENDER_TIMEOUT_S: int = 180

    # --- Parametros RIGIDOS do pipeline de video (NUNCA vem do request) ---
    # Fixos deliberadamente no backend, nao em VideoGenerateRequest: numa
    # RTX 3050 6GB, image-to-video acima disso estoura VRAM com facilidade.
    # O orchestrator monta o payload do ComfyUI sempre com estes valores
    # (ver app/services/orchestrator.py e app/providers/comfyui_video_provider.py).
    LTX_INPUT_IMAGE_MAX_SIDE: int = 768   # teto de redimensionamento da imagem de entrada (bate com LTX_WIDTH)
    LTX_WIDTH: int = 768                  # largura do latente de video (no LTXVImgToVideo)
    LTX_HEIGHT: int = 512                 # altura do latente de video
    LTX_LENGTH: int = 81                  # frames do latente de video (faixa validada: 65-97)
    LTX_LENGTH_FALLBACK: int = 65         # usado em retry apos OOM -- piso da faixa validada, nunca abaixo disso
    LTX_DENOISE: float = 1.0              # denoise no KSampler -- NUNCA reduzir, quebra o LTXVImgToVideo (nem no fallback)

    # --- Gestao de Recursos ---
    VRAM_TOTAL_MB: int = 6144           # RTX 3050 6GB
    VRAM_SAFETY_MARGIN_MB: int = 512    # margem de seguranca
    MAX_RETRIES_ON_OOM: int = 2

    # --- Armazenamento ---
    OUTPUT_DIR: Path = Path("./generated_images")
    OUTPUT_DIR_VIDEOS: Path = Path("./generated_videos")
    OUTPUT_DIR_MESHES: Path = Path("./generated_meshes")
    JOB_HISTORY_LIMIT: int = 200

    # --- Dublagem / Speech-to-Speech ---
    ELEVENLABS_API_KEY: str = ""
    ELEVENLABS_HOST: str = "https://api.elevenlabs.io"
    # Speech-to-Speech exige um modelo com can_do_voice_conversion. "eleven_multilingual_v2"
    # e um modelo de TTS e e rejeitado nesse endpoint.
    ELEVENLABS_DEFAULT_MODEL: str = "eleven_multilingual_sts_v2"
    ELEVENLABS_TIMEOUT_S: int = 120
    # voz usada quando o frontend nao envia voice_id (opcional; ex.: um voice_id da sua biblioteca)
    ELEVENLABS_DEFAULT_VOICE_ID: str = ""
    DEFAULT_DUBBING_PROVIDER: str = "elevenlabs"
    DEFAULT_PROVIDER_TIMEOUT_S: int = 120
    DUBBING_BACKGROUND_THRESHOLD_BYTES: int = 10 * 1024 * 1024

    # --- Dublagem por traducao local (XTTS v2 + faster-whisper + Ollama) ---
    # Modo default do endpoint de dublagem: "translation_dubbing" preserva a
    # voz original do falante e TRADUZ o audio (hoje fixado para entrada em
    # ingles -> saida em portugues); "voice_conversion" e o Speech-to-Speech
    # da ElevenLabs (troca a voz, NAO traduz).
    DUBBING_DEFAULT_MODE: str = "translation_dubbing"

    # XTTS v2 roda DENTRO do processo do nexus-bridge (torch). Requer uma venv
    # com Python < 3.14 (coqui-tts hoje so suporta >=3.10,<3.14) e o pacote
    # "coqui-tts" instalado -- ver requirements.txt.
    XTTS_MODEL_NAME: str = "tts_models/multilingual/multi-dataset/xtts_v2"
    XTTS_DEVICE: str = "auto"  # "auto" | "cuda" | "cpu"

    # faster-whisper para transcrever o audio de entrada antes da traducao.
    # "small" e um bom equilibrio para ingles numa RTX 3050 6GB, dado que o
    # modelo e carregado/descarregado por job (nunca fica residente junto
    # com XTTS/Ollama/Fooocus -- ver app/providers/whisper_stt.py).
    WHISPER_MODEL_SIZE: str = "small"
    WHISPER_DEVICE: str = "auto"  # "auto" | "cuda" | "cpu"
    WHISPER_SOURCE_LANGUAGE: str = "en"  # idioma de entrada fixo (nao detectado automaticamente)

    # Traducao do texto transcrito: reaproveita o Ollama ja configurado acima
    # (OLLAMA_HOST/OLLAMA_MODEL). Deixe em branco para usar OLLAMA_MODEL.
    TRANSLATION_OLLAMA_MODEL: str = ""
    TRANSLATION_TARGET_LANGUAGE: str = "pt"  # codigo curto aceito pelo XTTS v2 (nao "pt-BR")

    # --- API ---
    # NoDecode: sem isso o pydantic-settings tenta json.loads() no valor do .env ANTES do
    # validator abaixo e quebra com "error parsing value for field CORS_ORIGINS" quando o
    # valor e "a,b" (separado por virgula). Com NoDecode ambos os formatos funcionam.
    CORS_ORIGINS: Annotated[list[str], NoDecode] = [
        "http://localhost:3000", "http://127.0.0.1:3000",
        "http://localhost:5173", "http://127.0.0.1:5173",
    ]

    # --- Logs ---
    LOG_LEVEL: str = "INFO"

    # --- Saída de áudio ---
    OUTPUT_DIR_AUDIO: Path = Path("./generated_audio")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("ELEVENLABS_API_KEY", mode="before")
    @classmethod
    def clean_api_key(cls, v):
        # remove espacos, quebras de linha e aspas coladas por engano no .env
        return v.strip().strip("\"'").strip() if isinstance(v, str) else v

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                import json
                return json.loads(v)
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @model_validator(mode="after")
    def validate_vram(self):
        if self.VRAM_SAFETY_MARGIN_MB >= self.VRAM_TOTAL_MB:
            raise ValueError(
                f"VRAM_SAFETY_MARGIN_MB ({self.VRAM_SAFETY_MARGIN_MB}) nao pode ser "
                f">= VRAM_TOTAL_MB ({self.VRAM_TOTAL_MB}). Corrija o .env."
            )
        if self.MAX_RETRIES_ON_OOM < 0:
            raise ValueError("MAX_RETRIES_ON_OOM nao pode ser negativo.")
        return self


settings = Settings()
settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
settings.OUTPUT_DIR_VIDEOS.mkdir(parents=True, exist_ok=True)
settings.OUTPUT_DIR_AUDIO.mkdir(parents=True, exist_ok=True)
settings.OUTPUT_DIR_MESHES.mkdir(parents=True, exist_ok=True)
