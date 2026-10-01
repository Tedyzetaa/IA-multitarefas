from app.models import DubbingRequest, VoiceSettings


def test_voice_settings_validation() -> None:
    voice = VoiceSettings(stability=0.7, similarity_boost=0.9, style=0.3, speaker_boost=True)
    assert 0.0 <= voice.stability <= 1.0
    assert 0.0 <= voice.similarity_boost <= 1.0
    assert 0.0 <= voice.style <= 1.0
    assert voice.speaker_boost is True


def test_dubbing_request_accepts_valid_media() -> None:
    req = DubbingRequest(
        voice_id="voice_123",
        file_name="sample.wav",
        format="wav",
        output_format="mp3",
        model_id="eleven_multilingual_v2",
        target_language="pt-BR",
        voice_settings={"stability": 0.5, "similarity_boost": 0.8, "style": 0.2, "speaker_boost": True},
    )
    assert req.voice_id == "voice_123"
    assert req.format in {"wav", "mp3", "m4a"}
    assert req.output_format in {"wav", "mp3", "m4a"}
