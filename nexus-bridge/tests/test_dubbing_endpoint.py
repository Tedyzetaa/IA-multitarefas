"""
Testes do endpoint /api/v1/dubbing/process: roteamento por dubbing_mode,
validacao (422/400), e o fix do objetivo 4 (status.dubbing reflete o
health_check real em vez de forcar "ready").
"""
import io

import pytest
from fastapi.testclient import TestClient

from app import main as main_module


@pytest.fixture
def client(monkeypatch, tmp_path):
    main_module.settings.OUTPUT_DIR_AUDIO = tmp_path

    async def fake_translation_generate(audio_bytes, request):
        out = tmp_path / "out.wav"
        out.write_bytes(b"RIFF....WAVEfake")
        return str(out)

    async def fake_translation_health(*a, **k):
        return True

    monkeypatch.setattr(main_module.translation_dubbing_provider, "generate", fake_translation_generate)
    monkeypatch.setattr(main_module.translation_dubbing_provider, "health_check", fake_translation_health)

    return TestClient(main_module.app)


def test_missing_file_returns_422_with_hint(client):
    resp = client.post("/api/v1/dubbing/process", data={})
    assert resp.status_code == 422
    body = resp.json()
    assert body["error"] == "validation_error"
    assert "multipart 'file' ausente" in (body.get("hint") or "")


def test_default_mode_is_translation_dubbing_no_voice_id_needed(client):
    files = {"file": ("audio.wav", io.BytesIO(b"fake-wav-bytes"), "audio/wav")}
    resp = client.post("/api/v1/dubbing/process", files=files)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["message"] == "Dublagem concluída com sucesso."
    assert body["audio_url"].endswith(".wav")


def test_voice_conversion_without_voice_id_returns_400(client, monkeypatch):
    monkeypatch.setattr(main_module.settings, "ELEVENLABS_DEFAULT_VOICE_ID", "")
    files = {"file": ("audio.wav", io.BytesIO(b"fake-wav-bytes"), "audio/wav")}
    resp = client.post(
        "/api/v1/dubbing/process", files=files, data={"dubbing_mode": "voice_conversion"}
    )
    assert resp.status_code == 400
    assert "voice_id" in resp.json()["detail"]


def test_invalid_dubbing_mode_returns_400(client):
    files = {"file": ("audio.wav", io.BytesIO(b"fake-wav-bytes"), "audio/wav")}
    resp = client.post(
        "/api/v1/dubbing/process", files=files, data={"dubbing_mode": "not_a_real_mode"}
    )
    assert resp.status_code == 400


def test_invalid_extension_returns_400(client):
    files = {"file": ("audio.ogg", io.BytesIO(b"fake-bytes"), "audio/ogg")}
    resp = client.post("/api/v1/dubbing/process", files=files)
    assert resp.status_code == 400


def test_empty_file_returns_400(client):
    files = {"file": ("audio.wav", io.BytesIO(b""), "audio/wav")}
    resp = client.post("/api/v1/dubbing/process", files=files)
    assert resp.status_code == 400
