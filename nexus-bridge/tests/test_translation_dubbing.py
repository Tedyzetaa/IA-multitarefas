"""
Testes do provider translation_dubbing (whisper -> Ollama -> XTTS v2).

whisper_stt e xtts_provider sao MOCKADOS (monkeypatch) porque as libs pesadas
(faster-whisper, coqui-tts, torch) nao sao instaladas no ambiente de teste --
sem rede/GPU, so validamos a ORQUESTRACAO do pipeline. O Ollama e simulado
via httpx.MockTransport (sem rede real), como pedido no objetivo 7.
"""
import json

import httpx
import pytest

from app.config import settings
from app.models import DubbingRequest
from app.providers import whisper_stt, xtts_provider
from app.providers.ollama_provider import OllamaProvider
from app.providers.translation_dubbing_provider import TranslationDubbingProvider


def _ollama_mock_transport(translated_text: str = "Olá, isso é um teste."):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/chat":
            return httpx.Response(200, json={"message": {"content": translated_text}})
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": settings.OLLAMA_MODEL}]})
        return httpx.Response(404, json={"error": "not found"})

    return httpx.MockTransport(handler)


@pytest.fixture(autouse=True)
def _patch_whisper_and_xtts(monkeypatch, tmp_path):
    """Substitui as funcoes bloqueantes de STT/TTS por stubs deterministicos."""
    calls = {"transcribe": 0, "unload_whisper": 0, "synthesize": 0, "unload_xtts": 0}

    def fake_transcribe(audio_path, model_size, device, language):
        calls["transcribe"] += 1
        assert language == "en"
        return "Hello, this is a test."

    def fake_unload_whisper():
        calls["unload_whisper"] += 1

    def fake_synthesize(text, speaker_wav_path, language, model_name, device, output_dir):
        calls["synthesize"] += 1
        # A normalizacao 'pt-BR' -> 'pt' acontece DENTRO da xtts_provider.synthesize
        # real (ver test_normalize_language_mapping); aqui o mock recebe o valor cru
        # que o provider repassa (request.target_language).
        assert language == "pt-BR"
        out = output_dir / "fake_output.wav"
        output_dir.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"RIFF....WAVEfakecontent")
        return str(out)

    def fake_unload_xtts():
        calls["unload_xtts"] += 1

    monkeypatch.setattr(whisper_stt, "transcribe", fake_transcribe)
    monkeypatch.setattr(whisper_stt, "unload", fake_unload_whisper)
    monkeypatch.setattr(xtts_provider, "synthesize", fake_synthesize)
    monkeypatch.setattr(xtts_provider, "unload", fake_unload_xtts)
    return calls


@pytest.fixture
def ollama_provider_mocked(monkeypatch):
    """OllamaProvider cujo httpx.AsyncClient usa MockTransport (sem rede)."""
    provider = OllamaProvider(host="http://fake-ollama:11434", model="qwen2.5-coder:7b")

    real_async_client = httpx.AsyncClient

    def patched_async_client(*args, **kwargs):
        kwargs["transport"] = _ollama_mock_transport()
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched_async_client)
    return provider


@pytest.mark.asyncio
async def test_translation_dubbing_full_pipeline(_patch_whisper_and_xtts, ollama_provider_mocked, tmp_path):
    settings.OUTPUT_DIR_AUDIO = tmp_path
    provider = TranslationDubbingProvider(llm_provider=ollama_provider_mocked)
    request = DubbingRequest(
        dubbing_mode="translation_dubbing",
        file_name="input.wav",
        format="wav",
        source_language="en",
        target_language="pt-BR",
    )

    output_path = await provider.generate(b"fake-wav-bytes", request)

    assert output_path.endswith(".wav")
    assert _patch_whisper_and_xtts["transcribe"] == 1
    assert _patch_whisper_and_xtts["unload_whisper"] == 1
    assert _patch_whisper_and_xtts["synthesize"] == 1
    assert _patch_whisper_and_xtts["unload_xtts"] == 1


@pytest.mark.asyncio
async def test_translation_dubbing_empty_audio_raises(ollama_provider_mocked):
    provider = TranslationDubbingProvider(llm_provider=ollama_provider_mocked)
    request = DubbingRequest(dubbing_mode="translation_dubbing", file_name="input.wav", format="wav")
    with pytest.raises(ValueError):
        await provider.generate(b"", request)


@pytest.mark.asyncio
async def test_translation_dubbing_unloads_xtts_even_on_failure(monkeypatch, ollama_provider_mocked, tmp_path):
    """Se a sintese falhar, o XTTS deve ser descarregado mesmo assim (finally)."""
    settings.OUTPUT_DIR_AUDIO = tmp_path
    calls = {"unload_xtts": 0}

    monkeypatch.setattr(whisper_stt, "transcribe", lambda *a, **k: "Hello.")
    monkeypatch.setattr(whisper_stt, "unload", lambda: None)

    def failing_synthesize(*a, **k):
        raise xtts_provider.SynthesisError("boom")

    monkeypatch.setattr(xtts_provider, "synthesize", failing_synthesize)
    monkeypatch.setattr(xtts_provider, "unload", lambda: calls.__setitem__("unload_xtts", calls["unload_xtts"] + 1))

    provider = TranslationDubbingProvider(llm_provider=ollama_provider_mocked)
    request = DubbingRequest(dubbing_mode="translation_dubbing", file_name="input.wav", format="wav")

    from app.providers.base import ProviderUnavailableError
    with pytest.raises(ProviderUnavailableError):
        await provider.generate(b"fake-bytes", request)

    assert calls["unload_xtts"] == 1


def test_normalize_language_mapping():
    assert xtts_provider.normalize_language("pt-BR") == "pt"
    assert xtts_provider.normalize_language("PT_br") == "pt"
    with pytest.raises(xtts_provider.SynthesisError):
        xtts_provider.normalize_language("xx-YY")


def test_dubbing_request_defaults_to_translation_dubbing():
    req = DubbingRequest(file_name="a.wav", format="wav")
    assert req.dubbing_mode == "translation_dubbing"
    assert req.voice_id is None


def test_dubbing_request_voice_conversion_requires_voice_id():
    with pytest.raises(Exception):
        DubbingRequest(dubbing_mode="voice_conversion", file_name="a.wav", format="wav")
    ok = DubbingRequest(dubbing_mode="voice_conversion", voice_id="abc123", file_name="a.wav", format="wav")
    assert ok.voice_id == "abc123"
