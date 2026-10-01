"""
Worker standalone para transcricao com faster-whisper, executado em um
PROCESSO SEPARADO (via subprocess, chamado por app/providers/whisper_stt.py).

Motivo de existir: ctranslate2 (usado pelo faster-whisper) e o torch (usado
pelo XTTS v2) cada um pode acabar carregando/"vencendo" uma versao diferente
da DLL do cuDNN 9 no MESMO processo Windows, causando:

    Could not load symbol cudnnGetLibConfig. Error code 127

Trocar versoes de ctranslate2/torch/nvidia-cudnn-cu12 nao resolve de forma
confiavel, porque o Windows pode reaproveitar a DLL ja carregada em memoria
pelo primeiro dos dois a iniciar, mesmo que uma versao mais nova esteja
instalada. Isolando o Whisper num processo que termina e libera TODAS as
suas DLLs antes do XTTS/torch sequer iniciar, o conflito deixa de existir,
independente de qual versao de cuDNN cada um usa.

Uso (chamado internamente por whisper_stt.transcribe_isolated):
    python -m app.workers.whisper_worker <audio_path> <model_size> <device> <language>

Imprime em stdout uma UNICA linha JSON:
    {"ok": true, "transcript": "..."}
    {"ok": false, "error": "mensagem de erro"}
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 5:
        print(json.dumps({
            "ok": False,
            "error": f"Uso: whisper_worker.py <audio_path> <model_size> <device> <language> (recebi {sys.argv[1:]!r})",
        }))
        return 1

    audio_path, model_size, device, language = sys.argv[1:5]

    try:
        # Import local (nao no topo do modulo) para nao carregar faster-whisper
        # nem torch antes de sabermos que os argumentos estao ok.
        from app.providers import whisper_stt

        transcript = whisper_stt.transcribe(audio_path, model_size, device, language)
        print(json.dumps({"ok": True, "transcript": transcript}))
        return 0
    except Exception as exc:  # noqa: BLE001 - queremos capturar QUALQUER falha e reportar via JSON
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
