"""
Configuração centralizada do Nexus-Bridge.
Todos os parâmetros sensíveis a hardware ficam aqui, permitindo
ajuste rápido para diferentes GPUs/CPUs sem tocar no core.
"""
from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    # --- Ollama (LLM) ---
    OLLAMA_HOST: str = "http://127.0.0.1:11434"
    OLLAMA_MODEL: str = "qwen2.5-coder:7b"
    OLLAMA_KEEP_ALIVE_ACTIVE: str = "5m"   # tempo que o modelo fica em VRAM durante uso
    OLLAMA_KEEP_ALIVE_IDLE: str = "0"      # 0 = descarrega o modelo imediatamente apos uso

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

    # --- Gestao de Recursos ---
    VRAM_TOTAL_MB: int = 6144           # RTX 3050 6GB
    VRAM_SAFETY_MARGIN_MB: int = 512    # margem de seguranca
    MAX_RETRIES_ON_OOM: int = 2

    # --- Armazenamento ---
    OUTPUT_DIR: Path = Path("./generated_images")
    JOB_HISTORY_LIMIT: int = 200

    # --- API ---
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    class Config:
        env_file = ".env"


settings = Settings()
settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
