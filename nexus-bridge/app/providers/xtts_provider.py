"""
Sintese de voz local com XTTS v2 (pacote "coqui-tts"), usada pelo pipeline de
translation_dubbing como ULTIMO estagio: recebe o texto ja traduzido (Ollama)
e um arquivo de audio de referencia (o audio original enviado pelo usuario) e
sintetiza a fala no idioma alvo CLONANDO a voz do falante original.

Requer Python < 3.14 (limite atual do pacote "coqui-tts") e torch instalado
com suporte a CUDA compativel com o driver da GPU -- ver requirements.txt e a
observacao sobre instalacao do torch la.

Mesma disciplina de VRAM do whisper_stt.py: carrega sob demanda, expoe
unload(). NAO e assincrono -- envolver em asyncio.to_thread(...).
"""
import asyncio
import gc
import logging
import threading
import time
import uuid
from pathlib import Path

from app.gpu_lock import gpu_vram_lock

logger = logging.getLogger("nexus.xtts_provider")

_model = None
_model_lock = threading.Lock()
_loaded_config: tuple[str, str] | None = None  # (model_name, device) atualmente carregado
_idle_unload_task: asyncio.Task | None = None
_last_activity_ts = 0.0
_IDLE_UNLOAD_SECONDS = 300

# Idiomas suportados pelo XTTS v2 (codigos curtos, SEM variante regional --
# "pt-BR" deve ser normalizado para "pt" antes de chegar aqui).
SUPPORTED_LANGUAGES = {
    "en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru",
    "nl", "cs", "ar", "zh-cn", "ja", "hu", "ko",
}


class SynthesisError(Exception):
    """Levantada quando a sintese falha ou o idioma nao e suportado."""


def normalize_language(lang: str) -> str:
    """'pt-BR'/'pt_br' -> 'pt'. Levanta SynthesisError se o idioma nao for suportado."""
    short = (lang or "").strip().lower().replace("_", "-").split("-")[0]
    if short not in SUPPORTED_LANGUAGES:
        raise SynthesisError(
            f"Idioma alvo '{lang}' nao suportado pelo XTTS v2. "
            f"Suportados: {sorted(SUPPORTED_LANGUAGES)}"
        )
    return short


def _resolve_device(device: str) -> str:
    if device in ("cpu", "cuda"):
        return device
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _clear_cuda_cache() -> None:
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def schedule_idle_unload() -> None:
    """Agenda descarregamento do XTTS após 300s sem uso e limpa o cache CUDA."""
    global _idle_unload_task
    if _idle_unload_task is not None and not _idle_unload_task.done():
        return

    _idle_unload_task = asyncio.create_task(_idle_wait_and_unload())


async def _idle_wait_and_unload() -> None:
    try:
        await asyncio.sleep(_IDLE_UNLOAD_SECONDS)
    finally:
        if time.monotonic() - _last_activity_ts >= _IDLE_UNLOAD_SECONDS:
            unload()


def _load_model(model_name: str, device: str):
    global _model, _loaded_config, _last_activity_ts
    try:
        from TTS.api import TTS
    except ImportError as exc:
        raise SynthesisError(
            "Pacote 'coqui-tts' nao instalado (ou Python >= 3.14, que nao e suportado "
            "pelo coqui-tts). Rode 'pip install coqui-tts' numa venv com Python < 3.14."
        ) from exc

    resolved_device = _resolve_device(device)
    logger.info("Carregando XTTS v2 (%s, device=%s)...", model_name, resolved_device)
    model = TTS(model_name).to(resolved_device)
    _model = model
    _loaded_config = (model_name, device)
    _last_activity_ts = time.monotonic()
    schedule_idle_unload()
    return _model


def _synthesize_impl(
    text: str,
    speaker_wav_path: str,
    language: str,
    model_name: str,
    device: str,
    output_dir: Path,
) -> str:
    if not text or not text.strip():
        raise SynthesisError("Texto vazio para sintese.")
    lang = normalize_language(language)

    with _model_lock:
        model = _model
        if model is None or _loaded_config != (model_name, device):
            model = _load_model(model_name, device)

        output_dir.mkdir(parents=True, exist_ok=True)
        out_path = output_dir / f"{uuid.uuid4()}.wav"
        try:
            model.tts_to_file(
                text=text,
                speaker_wav=speaker_wav_path,
                language=lang,
                file_path=str(out_path),
            )
            global _last_activity_ts
            _last_activity_ts = time.monotonic()
            if _idle_unload_task is not None and not _idle_unload_task.done():
                _idle_unload_task.cancel()
            schedule_idle_unload()
        except Exception as exc:
            raise SynthesisError(f"Falha ao sintetizar audio com XTTS v2: {exc!r}") from exc

    if not out_path.exists() or out_path.stat().st_size == 0:
        raise SynthesisError("XTTS v2 nao gerou um arquivo de audio valido.")
    return str(out_path)


def synthesize(
    text: str,
    speaker_wav_path: str,
    language: str,
    model_name: str,
    device: str,
    output_dir: Path,
) -> str:
    """Sintetiza `text` clonando a voz de speaker_wav_path. BLOQUEANTE -- usar asyncio.to_thread."""

    async def _locked_run() -> str:
        async with gpu_vram_lock:
            return _synthesize_impl(
                text=text,
                speaker_wav_path=speaker_wav_path,
                language=language,
                model_name=model_name,
                device=device,
                output_dir=output_dir,
            )

    return asyncio.run(_locked_run())


def unload() -> None:
    """Libera o modelo XTTS da VRAM/RAM. Chamar apos o job terminar (sucesso ou falha)."""
    global _model, _loaded_config, _idle_unload_task, _last_activity_ts
    with _model_lock:
        if _model is not None:
            del _model
            _model = None
            _loaded_config = None
            _last_activity_ts = 0.0
            gc.collect()
            _clear_cuda_cache()
            if _idle_unload_task is not None:
                _idle_unload_task.cancel()
                _idle_unload_task = None
            logger.info("Modelo XTTS v2 descarregado.")
