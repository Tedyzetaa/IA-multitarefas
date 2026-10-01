"""
Estrategia de dublagem "translation_dubbing": preserva a voz original do
falante e TRADUZ o audio, ao contrario do Speech-to-Speech da ElevenLabs
(app/providers/dubbing_provider.py), que troca a voz e NAO traduz.

Pipeline (100% local, sem chamada externa):
    1. Grava audio_bytes em um arquivo temporario.
    2. Transcreve o audio (faster-whisper) -- app/providers/whisper_stt.py.
    3. Descarrega o whisper (libera VRAM) e traduz o texto via Ollama
       (OllamaProvider.translate_text), que ja gerencia seu proprio
       keep_alive/unload.
    4. Sintetiza o texto traduzido com XTTS v2, clonando a voz do arquivo
       original -- app/providers/xtts_provider.py.
    5. Descarrega o XTTS (libera VRAM) e apaga o arquivo temporario.

Mesma interface publica de app/providers/dubbing_provider.py (generate,
health_check) para que app/services/orchestrator.py trate as duas
estrategias de forma intercambiavel.
"""
"""
Estrategia de dublagem "translation_dubbing": preserva a voz original do
falante e TRADUZ o audio, ao contrario do Speech-to-Speech da ElevenLabs
(app/providers/dubbing_provider.py), que troca a voz e NAO traduz.

Dois fluxos:

1) generate() -- fluxo automatico de ponta a ponta (usado pela fila de
   background para arquivos grandes, ver app/main.py). whisper -> Ollama ->
   XTTS sem parar para revisao humana.

2) create_preview() + synthesize_from_preview() -- fluxo em 2 passos para o
   usuario REVISAR/CORRIGIR a traducao antes de sintetizar:
     a. create_preview(): grava o audio original numa pasta de sessao,
        transcreve (faster-whisper, processo isolado) e traduz (Ollama).
        Devolve session_id + transcript + translated_text (o frontend mostra
        translated_text numa caixa de texto editavel).
     b. synthesize_from_preview(): recebe o session_id + o texto (ja editado
        pelo usuario) e sintetiza com XTTS v2. Clona a voz de reference_voice
        se o usuario enviou um audio de referencia; senao usa o audio
        original da sessao (o mesmo gravado no passo a) como referencia.
        Ao final, apaga os arquivos da sessao.

Sessoes ficam em disco (nao sao mantidas indefinidamente): expiram sozinhas
apos _SESSION_TTL_SECONDS se o usuario nunca confirmar o passo 2 (limpas de
forma preguicosa a cada nova chamada de create_preview).
"""
import asyncio
import logging
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path

from app.config import settings
from app.models import DubbingRequest
from app.providers import whisper_stt, xtts_provider
from app.providers.base import ProviderUnavailableError
from app.providers.ollama_provider import OllamaProvider

logger = logging.getLogger("nexus.translation_dubbing_provider")

# Pasta onde ficam os arquivos temporarios de cada sessao de preview
# (audio original enviado +, se houver, o audio de referencia de voz).
_SESSIONS_DIR = Path(tempfile.gettempdir()) / "nexus_bridge_dubbing_sessions"
_SESSIONS: dict[str, dict] = {}
_SESSIONS_LOCK = threading.Lock()
_SESSION_TTL_SECONDS = 30 * 60  # 30 min sem confirmar o passo 2 -> sessao expira


def _cleanup_stale_sessions() -> None:
    now = time.time()
    with _SESSIONS_LOCK:
        stale_ids = [sid for sid, s in _SESSIONS.items() if now - s["created_at"] > _SESSION_TTL_SECONDS]
        stale = [(sid, _SESSIONS.pop(sid)) for sid in stale_ids]
    for sid, session in stale:
        shutil.rmtree(session["session_dir"], ignore_errors=True)
        logger.info("[translation_dubbing] Sessão de preview %s expirou (>%ds sem confirmar) e foi limpa.", sid, _SESSION_TTL_SECONDS)


class TranslationDubbingProvider:
    """Dublagem por traducao local (whisper -> Ollama -> XTTS v2)."""

    provider_name = "translation_dubbing_local"

    def __init__(self, llm_provider: OllamaProvider | None = None):
        # Reaproveita o mesmo OllamaProvider/host/model usado no refinamento
        # de prompt de imagem/video (settings.OLLAMA_HOST/OLLAMA_MODEL).
        self.llm = llm_provider or OllamaProvider()

    async def health_check(self) -> bool:
        # STT/XTTS carregam sob demanda (o erro real aparece em generate() se
        # os pacotes nao estiverem instalados); o unico dependente externo
        # de verdade aqui e o Ollama, entao o health check reflete ele.
        return await self.llm.health_check()

    async def generate(self, audio_bytes: bytes, request: DubbingRequest) -> str:
        if not audio_bytes:
            raise ValueError("Arquivo de áudio vazio para dublagem.")

        source_lang = (request.source_language or settings.WHISPER_SOURCE_LANGUAGE or "en").strip()
        target_lang = (request.target_language or settings.TRANSLATION_TARGET_LANGUAGE or "pt").strip()

        suffix = f".{(request.format or 'wav').lower()}"
        tmp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = Path(tmp.name)

            logger.info(
                "[translation_dubbing] Transcrevendo %s (%s)...", tmp_path.name, source_lang
            )
            # transcribe_isolated roda o faster-whisper/ctranslate2 num processo
            # separado (evita conflito de DLL do cuDNN 9 com o torch/XTTS que
            # carrega logo depois, no processo principal).
            transcript = await asyncio.to_thread(
                whisper_stt.transcribe_isolated,
                str(tmp_path),
                settings.WHISPER_MODEL_SIZE,
                settings.WHISPER_DEVICE,
                source_lang,
            )
            logger.info("[translation_dubbing] Transcrição (%d chars): %s", len(transcript), transcript[:200])

            logger.info("[translation_dubbing] Traduzindo %s -> %s via Ollama...", source_lang, target_lang)
            translated_text = await self.llm.translate_text(
                transcript,
                source_lang=source_lang,
                target_lang=target_lang,
                model=settings.TRANSLATION_OLLAMA_MODEL or None,
            )
            await self.llm.clear_context()
            logger.info("[translation_dubbing] Tradução (%d chars): %s", len(translated_text), translated_text[:200])

            logger.info("[translation_dubbing] Sintetizando com XTTS v2 (voz clonada, idioma=%s)...", target_lang)
            output_path = await asyncio.to_thread(
                xtts_provider.synthesize,
                translated_text,
                str(tmp_path),
                target_lang,
                settings.XTTS_MODEL_NAME,
                settings.XTTS_DEVICE,
                settings.OUTPUT_DIR_AUDIO,
            )
            return output_path

        except (whisper_stt.TranscriptionError, xtts_provider.SynthesisError) as exc:
            raise ProviderUnavailableError(str(exc)) from exc
        finally:
            await asyncio.to_thread(xtts_provider.unload)
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)

    # ------------------------------------------------------------------
    # Fluxo em 2 passos (revisao humana da traducao antes de sintetizar)
    # ------------------------------------------------------------------

    async def create_preview(
        self,
        audio_bytes: bytes,
        suffix: str,
        source_language: str | None,
        target_language: str | None,
    ) -> dict:
        """Passo 1: transcreve + traduz e guarda o audio original numa sessao.
        NAO sintetiza ainda -- devolve o texto para o usuario revisar."""
        if not audio_bytes:
            raise ValueError("Arquivo de áudio vazio para dublagem.")

        _cleanup_stale_sessions()

        source_lang = (source_language or settings.WHISPER_SOURCE_LANGUAGE or "en").strip()
        target_lang = (target_language or settings.TRANSLATION_TARGET_LANGUAGE or "pt").strip()

        session_id = str(uuid.uuid4())
        session_dir = _SESSIONS_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        audio_path = session_dir / f"original.{(suffix or 'wav').lstrip('.').lower()}"
        audio_path.write_bytes(audio_bytes)

        try:
            logger.info("[translation_dubbing] (preview) Transcrevendo %s (%s)...", audio_path.name, source_lang)
            transcript = await asyncio.to_thread(
                whisper_stt.transcribe_isolated,
                str(audio_path),
                settings.WHISPER_MODEL_SIZE,
                settings.WHISPER_DEVICE,
                source_lang,
            )
            logger.info("[translation_dubbing] (preview) Transcrição (%d chars): %s", len(transcript), transcript[:200])

            logger.info("[translation_dubbing] (preview) Traduzindo %s -> %s via Ollama...", source_lang, target_lang)
            translated_text = await self.llm.translate_text(
                transcript,
                source_lang=source_lang,
                target_lang=target_lang,
                model=settings.TRANSLATION_OLLAMA_MODEL or None,
            )
            await self.llm.clear_context()
            logger.info("[translation_dubbing] (preview) Tradução (%d chars): %s", len(translated_text), translated_text[:200])
        except whisper_stt.TranscriptionError as exc:
            shutil.rmtree(session_dir, ignore_errors=True)
            raise ProviderUnavailableError(str(exc)) from exc
        except Exception:
            shutil.rmtree(session_dir, ignore_errors=True)
            raise

        with _SESSIONS_LOCK:
            _SESSIONS[session_id] = {
                "session_dir": session_dir,
                "audio_path": audio_path,
                "source_lang": source_lang,
                "target_lang": target_lang,
                "created_at": time.time(),
            }

        return {
            "session_id": session_id,
            "transcript": transcript,
            "translated_text": translated_text,
            "source_language": source_lang,
            "target_language": target_lang,
        }

    async def synthesize_from_preview(
        self,
        session_id: str,
        translated_text: str,
        target_language: str | None,
        reference_voice_bytes: bytes | None,
        reference_voice_suffix: str | None,
    ) -> str:
        """Passo 2: sintetiza translated_text (ja revisado pelo usuario) com XTTS v2.
        Usa reference_voice_bytes como voz de referencia se fornecido; senao clona a
        voz do audio original guardado no passo 1 (create_preview)."""
        with _SESSIONS_LOCK:
            session = _SESSIONS.pop(session_id, None)

        if session is None:
            raise ProviderUnavailableError(
                f"Sessão de preview '{session_id}' não encontrada ou expirada "
                f"(expira {_SESSION_TTL_SECONDS // 60} min após a transcrição). Envie o áudio novamente."
            )

        if not translated_text or not translated_text.strip():
            shutil.rmtree(session["session_dir"], ignore_errors=True)
            raise ValueError("translated_text vazio -- revise o texto antes de sintetizar.")

        target_lang = (target_language or session["target_lang"] or settings.TRANSLATION_TARGET_LANGUAGE or "pt").strip()

        try:
            if reference_voice_bytes:
                reference_path = session["session_dir"] / f"reference.{(reference_voice_suffix or 'wav').lstrip('.').lower()}"
                reference_path.write_bytes(reference_voice_bytes)
                speaker_wav_path = reference_path
                logger.info("[translation_dubbing] Sintetizando com voz de referência enviada pelo usuário.")
            else:
                speaker_wav_path = session["audio_path"]
                logger.info("[translation_dubbing] Nenhuma voz de referência enviada -- usando o áudio original como referência.")

            logger.info("[translation_dubbing] Sintetizando com XTTS v2 (idioma=%s)...", target_lang)
            output_path = await asyncio.to_thread(
                xtts_provider.synthesize,
                translated_text.strip(),
                str(speaker_wav_path),
                target_lang,
                settings.XTTS_MODEL_NAME,
                settings.XTTS_DEVICE,
                settings.OUTPUT_DIR_AUDIO,
            )
            return output_path
        except xtts_provider.SynthesisError as exc:
            raise ProviderUnavailableError(str(exc)) from exc
        finally:
            await asyncio.to_thread(xtts_provider.unload)
            shutil.rmtree(session["session_dir"], ignore_errors=True)
