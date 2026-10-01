import io
import json
import logging
import time
import uuid
import wave
from typing import Any

import httpx

from app.config import settings
from app.models import DubbingRequest
from app.providers.base import BaseProvider, ProviderUnavailableError

logger = logging.getLogger("nexus.dubbing_provider")

# Modelos aceitos pelo endpoint /v1/speech-to-speech (can_do_voice_conversion).
# "eleven_multilingual_v2" & cia sao modelos de TTS e NAO funcionam aqui.
_STS_MODELS = {"eleven_multilingual_sts_v2", "eleven_english_sts_v2"}

_HEALTH_TTL_S = 60.0  # /api/status e /api/health chamam health_check a cada poll do frontend


def _extract_error(response: httpx.Response) -> tuple[str, str]:
    """Extrai (status, message) do corpo de erro da ElevenLabs, sem nunca expor a chave."""
    try:
        detail = response.json().get("detail")
        if isinstance(detail, dict):
            return str(detail.get("status", "")), str(detail.get("message", ""))
        if isinstance(detail, list) and detail:
            return "validation_error", json.dumps(detail)[:300]
        return "", str(detail)[:300]
    except Exception:
        return "", response.text[:300]


class DubbingProvider(BaseProvider):
    """Provider para dublagem expressiva com ElevenLabs Speech-to-Speech.

    Observacao: Speech-to-Speech (voice changer) troca a VOZ preservando a
    entonacao/emocao do audio original; ele NAO traduz. Traducao/dublagem entre
    idiomas e outro produto (API /v1/dubbing).
    """

    provider_name = "elevenlabs"

    def __init__(
        self,
        api_key: str | None = None,
        host: str | None = None,
        timeout_s: float | None = None,
    ) -> None:
        self.api_key = (api_key or settings.ELEVENLABS_API_KEY or "").strip().strip("\"'")
        self.host = (host or settings.ELEVENLABS_HOST).rstrip("/")
        self.timeout_s = timeout_s or settings.ELEVENLABS_TIMEOUT_S
        self._health_cache: tuple[float, bool] | None = None

    # ------------------------------------------------------------------ health
    async def health_check(self) -> bool:
        now = time.monotonic()
        if self._health_cache and now - self._health_cache[0] < _HEALTH_TTL_S:
            return self._health_cache[1]
        ok = await self._probe()
        self._health_cache = (now, ok)
        return ok

    async def _probe(self) -> bool:
        if not self.api_key:
            logger.error("ELEVENLABS_API_KEY ausente no .env. Dublagem em modo offline.")
            return False

        try:
            async with httpx.AsyncClient(timeout=min(self.timeout_s, 15)) as client:
                response = await client.get(
                    f"{self.host}/v1/voices",
                    headers={"xi-api-key": self.api_key},
                )
        except httpx.HTTPError as exc:  # ConnectError, Timeout, ReadError, ProtocolError...
            logger.error("Nao foi possivel contatar a ElevenLabs em %s: %r", self.host, exc)
            return False

        if response.status_code == 200:
            return True

        status, message = _extract_error(response)
        if response.status_code == 401 and status == "missing_permissions":
            # A chave AUTENTICA, mas e uma chave restrita sem a permissao de listar vozes.
            # Isso nao impede a dublagem se ela tiver a permissao de speech_to_speech.
            logger.warning(
                "ElevenLabs 401 missing_permissions: %s -- a chave e valida mas restrita. "
                "Garanta 'Speech to Speech' (e 'Voices: Read') em elevenlabs.io > API Keys.",
                message,
            )
            return True

        logger.error(
            "ElevenLabs GET /v1/voices -> HTTP %s (status=%r): %s | chave: len=%d, prefixo=%r. "
            "401 = chave invalida/revogada/de outra conta (ou plano free bloqueado por VPN/proxy).",
            response.status_code, status, message, len(self.api_key), self.api_key[:3],
        )
        return False

    # ----------------------------------------------------------------- process
    async def process(self, audio_bytes: bytes, request: DubbingRequest) -> bytes:
        """Processa uma faixa de audio e retorna o resultado em bytes."""
        if not audio_bytes:
            raise ValueError("Arquivo de áudio vazio para dublagem.")

        if request.provider == "local_flow_matching":
            raise NotImplementedError(
                "Suporte local de Flow Matching ainda não implementado; use o provider elevenlabs."
            )

        if not self.api_key:
            raise ProviderUnavailableError("ELEVENLABS_API_KEY não configurada no .env.")

        model_id = self._resolve_model_id(request.model_id)
        vs = request.voice_settings
        # Form fields do endpoint: model_id, voice_settings (JSON em string). O formato de
        # saida (output_format) e QUERY PARAM neste endpoint, nao campo do multipart.
        data: dict[str, Any] = {
            "model_id": model_id,
            "voice_settings": json.dumps({
                "stability": vs.stability,
                "similarity_boost": vs.similarity_boost,
                "style": vs.style,
                "use_speaker_boost": vs.speaker_boost,  # nome do campo na API da ElevenLabs
            }),
        }
        if request.target_language or request.language_code:
            logger.warning(
                "target_language/language_code ignorados: Speech-to-Speech nao traduz "
                "(so converte a voz). Para traduzir use a API de Dubbing da ElevenLabs."
            )

        file_name = request.file_name or f"source.{request.format}"
        files = {"audio": (file_name, audio_bytes, self._audio_mime_type(request.format))}
        params = {"output_format": self._map_output_format(request.output_format)}

        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(
                    f"{self.host}/v1/speech-to-speech/{request.voice_id}",
                    headers={
                        "xi-api-key": self.api_key,
                        "Accept": self._audio_accept_header(request.output_format),
                    },
                    params=params,
                    data=data,
                    files=files,
                )
                response.raise_for_status()
                content = response.content
        except httpx.TimeoutException as exc:
            raise TimeoutError(
                f"Timeout ao consultar ElevenLabs para dublagem do voice_id={request.voice_id}."
            ) from exc
        except httpx.HTTPStatusError as exc:
            status, message = _extract_error(exc.response)
            hint = ""
            if exc.response.status_code == 401:
                hint = " (chave inválida/revogada ou sem a permissão 'Speech to Speech')"
            logger.error("ElevenLabs STS -> HTTP %s (%s): %s", exc.response.status_code, status, message)
            raise ProviderUnavailableError(
                f"ElevenLabs respondeu HTTP {exc.response.status_code}{hint}: {message}"
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError(
                f"Falha de comunicação com ElevenLabs em {self.host}: {exc!r}"
            ) from exc

        if request.output_format.lower() == "wav" and not content.startswith(b"RIFF"):
            content = self._pcm16_to_wav(content, sample_rate=16000)
        return content

    async def generate(self, audio_bytes: bytes, request: DubbingRequest) -> str:
        """Salva a saída em disco e devolve o caminho do arquivo gerado."""
        generated_audio = await self.process(audio_bytes, request)
        output_dir = settings.OUTPUT_DIR_AUDIO
        output_dir.mkdir(parents=True, exist_ok=True)

        extension = request.output_format.lower()
        if extension not in {"mp3", "wav", "m4a"}:
            extension = "mp3"

        filepath = output_dir / f"{uuid.uuid4()}.{extension}"
        filepath.write_bytes(generated_audio)
        logger.info("Dublagem salva em %s", filepath)
        return str(filepath)

    # ----------------------------------------------------------------- helpers
    @staticmethod
    def _resolve_model_id(model_id: str | None) -> str:
        if model_id in _STS_MODELS:
            return model_id
        fallback = settings.ELEVENLABS_DEFAULT_MODEL
        if fallback not in _STS_MODELS:
            fallback = "eleven_multilingual_sts_v2"
        if model_id:
            logger.warning(
                "model_id=%r nao suporta Speech-to-Speech; usando %r.", model_id, fallback
            )
        return fallback

    @staticmethod
    def _pcm16_to_wav(pcm: bytes, sample_rate: int) -> bytes:
        """pcm_16000 da ElevenLabs e PCM S16LE cru (sem header) -> embrulha em WAV tocavel."""
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm)
        return buf.getvalue()

    @staticmethod
    def _map_output_format(output_format: str) -> str:
        mapping = {
            "mp3": "mp3_44100_128",
            "wav": "pcm_16000",
            "m4a": "aac_44100_128kbps",
        }
        return mapping.get(output_format.lower(), "mp3_44100_128")

    @staticmethod
    def _audio_accept_header(output_format: str) -> str:
        mapping = {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4"}
        return mapping.get(output_format.lower(), "audio/mpeg")

    @staticmethod
    def _audio_mime_type(fmt: str) -> str:
        mapping = {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4"}
        return mapping.get(fmt.lower(), "audio/mpeg")
