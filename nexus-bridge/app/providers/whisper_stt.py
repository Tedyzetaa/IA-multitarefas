"""
Transcricao (STT) local com faster-whisper, usada pelo pipeline de
translation_dubbing ANTES da traducao (Ollama) e da sintese (XTTS v2).

Carrega o modelo sob demanda e expoe unload() para liberar VRAM/RAM antes de
acionar o proximo estagio do pipeline -- mesma disciplina ja usada pelo
OllamaProvider.clear_context() (nunca dois modelos pesados residentes ao
mesmo tempo numa GPU de 6GB).

NAO e assincrono de verdade: faster-whisper e uma biblioteca sincrona/CPU-bound
em torno de ctranslate2. Quem chama este modulo deve envolver as funcoes
publicas em asyncio.to_thread(...) para nao bloquear o event loop do FastAPI.
"""
import gc
import json
import logging
import subprocess
import sys
import threading
from pathlib import Path

from app.providers.cuda_dlls import ensure_cuda_dlls

logger = logging.getLogger("nexus.whisper_stt")

# Raiz do projeto (.. duas pastas acima deste arquivo: app/providers/whisper_stt.py -> app/ -> raiz)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]

_model = None
_model_lock = threading.Lock()
_loaded_config: tuple[str, str] | None = None  # (model_size, device) atualmente carregado


class TranscriptionError(Exception):
    """Levantada quando a transcricao falha ou o resultado vem vazio."""


def _resolve_device_compute(device: str) -> tuple[str, str]:
    """Decide (device, compute_type) para o CTranslate2 por baixo do faster-whisper."""
    ensure_cuda_dlls()
    if device == "cpu":
        return "cpu", "int8"

    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass

    if device == "cuda":
        raise TranscriptionError(
            "WHISPER_DEVICE=cuda mas nenhuma GPU CUDA disponivel para o ctranslate2 instalado."
        )
    return "cpu", "int8"


def _load_model(model_size: str, device: str):
    global _model, _loaded_config
    ensure_cuda_dlls()
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise TranscriptionError(
            "Pacote 'faster-whisper' nao instalado. Rode "
            "'pip install faster-whisper' na venv do nexus-bridge."
        ) from exc

    resolved_device, compute_type = _resolve_device_compute(device)
    logger.info(
        "Carregando faster-whisper (model=%s, device=%s, compute_type=%s)...",
        model_size, resolved_device, compute_type,
    )
    _model = WhisperModel(model_size, device=resolved_device, compute_type=compute_type)
    _loaded_config = (model_size, device)
    return _model


def transcribe(audio_path: str, model_size: str, device: str, language: str = "en") -> str:
    """Transcreve o arquivo em audio_path. BLOQUEANTE -- chamar via asyncio.to_thread."""
    with _model_lock:
        model = _model
        if model is None or _loaded_config != (model_size, device):
            model = _load_model(model_size, device)
        try:
            segments, _info = model.transcribe(audio_path, language=language, vad_filter=True)
            text = " ".join(seg.text.strip() for seg in segments).strip()
        except Exception as exc:
            raise TranscriptionError(f"Falha ao transcrever audio com whisper: {exc!r}") from exc

    if not text:
        raise TranscriptionError(
            "Transcricao vazia -- o audio pode nao conter fala detectavel em "
            f"'{language}', ou o arquivo esta corrompido/silencioso."
        )
    return text


def unload() -> None:
    """Libera o modelo whisper da VRAM/RAM. Chamar antes de acionar o XTTS."""
    global _model, _loaded_config
    with _model_lock:
        if _model is not None:
            del _model
            _model = None
            _loaded_config = None
            gc.collect()
            logger.info("Modelo whisper descarregado.")


def transcribe_isolated(
    audio_path: str, model_size: str, device: str, language: str = "en", timeout: float = 300.0
) -> str:
    """
    Mesmo resultado de transcribe(), mas rodando o faster-whisper/ctranslate2
    em um PROCESSO FILHO separado (subprocess), que termina e libera todas as
    suas DLLs (incluindo cuDNN) antes de retornar.

    Isso evita o conflito de DLL do cuDNN 9 entre ctranslate2 e torch quando
    ambos rodam no mesmo processo (erro "Could not load symbol
    cudnnGetLibConfig. Error code 127" ao carregar o XTTS logo em seguida).

    BLOQUEANTE -- chamar via asyncio.to_thread, assim como transcribe().
    """
    cmd = [
        sys.executable, "-m", "app.workers.whisper_worker",
        audio_path, model_size, device, language,
    ]
    try:
        result = subprocess.run(
            cmd,
            cwd=str(_PROJECT_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise TranscriptionError(
            f"Whisper (processo isolado) excedeu o timeout de {timeout}s."
        ) from exc

    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()

    # O worker imprime UMA linha JSON em stdout. Pega a ultima linha nao-vazia
    # (por seguranca, caso alguma lib solte lixo em stdout antes do JSON).
    last_line = next((line for line in reversed(stdout.splitlines()) if line.strip()), "")

    try:
        payload = json.loads(last_line)
    except (json.JSONDecodeError, ValueError) as exc:
        raise TranscriptionError(
            "Nao foi possivel interpretar a saida do whisper_worker (processo isolado). "
            f"returncode={result.returncode}, stdout={stdout!r}, stderr={stderr[-2000:]!r}"
        ) from exc

    if not payload.get("ok"):
        raise TranscriptionError(
            f"Falha ao transcrever audio com whisper (processo isolado): {payload.get('error')}"
        )

    text = (payload.get("transcript") or "").strip()
    if not text:
        raise TranscriptionError(
            "Transcricao vazia -- o audio pode nao conter fala detectavel em "
            f"'{language}', ou o arquivo esta corrompido/silencioso."
        )
    return text
