# Nexus-Bridge — translation_dubbing (XTTS v2 local) — resumo da entrega

## O que foi implementado nesta rodada

Pipeline de dublagem local **preserva a voz original e traduz** (EN → PT):
`faster-whisper` (transcrição) → `Ollama` (tradução, reaproveitando o já
configurado) → `XTTS v2` (síntese clonando a voz do áudio original).
`translation_dubbing` agora é o modo **default** do endpoint. O modo antigo
(`voice_conversion`, Speech-to-Speech da ElevenLabs) continua disponível via
`dubbing_mode=voice_conversion`, agora exigindo `voice_id` só nesse caso.

## Mudanças por arquivo

- **`app/providers/whisper_stt.py`** (novo) — wrapper do faster-whisper.
  Carrega o modelo sob demanda, `transcribe()` bloqueante (rodar via
  `asyncio.to_thread`), `unload()` libera VRAM/RAM antes do próximo estágio.
  Erros de dependência ausente viram `TranscriptionError` com instrução clara.

- **`app/providers/xtts_provider.py`** (novo) — wrapper do XTTS v2
  (`coqui-tts`). `normalize_language()` mapeia `pt-BR` → `pt` (XTTS só aceita
  códigos curtos). `synthesize()` clona a voz a partir do áudio original
  (`speaker_wav`). `unload()` libera o modelo da GPU.

- **`app/providers/translation_dubbing_provider.py`** (novo) — orquestra o
  pipeline completo: grava em arquivo temporário → transcreve → descarrega
  whisper → traduz via Ollama → sintetiza com XTTS → descarrega XTTS → apaga
  o temporário (bloco `finally`, roda mesmo em erro). Mesma interface pública
  (`generate`, `health_check`) do `DubbingProvider` existente, para o
  orchestrator tratar as duas estratégias de forma intercambiável.

- **`app/providers/ollama_provider.py`** — adicionado `translate_text()`,
  reaproveitando o mesmo host/modelo/cliente já usado no refinamento de
  prompt de imagem/vídeo.

- **`app/models.py`** — `DubbingRequest` ganhou `dubbing_mode`
  (`"voice_conversion" | "translation_dubbing"`, default
  `"translation_dubbing"`) e `source_language` (default `"en"`). `voice_id`
  virou opcional no schema, com um `model_validator` exigindo-o só quando
  `dubbing_mode="voice_conversion"`.

- **`app/config.py`** — novo bloco de settings: `DUBBING_DEFAULT_MODE`,
  `XTTS_MODEL_NAME`, `XTTS_DEVICE`, `WHISPER_MODEL_SIZE`, `WHISPER_DEVICE`,
  `WHISPER_SOURCE_LANGUAGE`, `TRANSLATION_OLLAMA_MODEL`,
  `TRANSLATION_TARGET_LANGUAGE`.

- **`app/services/orchestrator.py`**:
  - `_select_dubbing_strategy()` escolhe `DubbingProvider` ou
    `TranslationDubbingProvider` por `job.request.dubbing_mode`.
  - **Fix do objetivo 4**: o `finally` chamava `status_manager.set_dubbing("ready")`
    incondicionalmente (escondia um 401/offline real). Agora, para jobs de
    áudio, chama `health_check()` da estratégia efetivamente usada e reflete
    `"ready"`/`"offline"` de verdade.

- **`app/main.py`** — instancia `TranslationDubbingProvider` (reaproveitando
  o mesmo `OllamaProvider` do pipeline de imagem/vídeo) e injeta as duas
  estratégias no orchestrator. Endpoint `/api/v1/dubbing/process` ganhou
  `dubbing_mode` e `source_language` como campos de formulário;
  `voice_id` só é exigido em `voice_conversion`. O caminho síncrono (arquivo
  pequeno) agora roteia para a estratégia certa e reflete a extensão REAL do
  arquivo gerado (XTTS sempre grava `.wav`, independente do `output_format`
  pedido). `/api/status`, `/api/health` e o startup usam um helper
  (`_default_dubbing_strategy`) que segue `DUBBING_DEFAULT_MODE`.

- **`requirements.txt`** — adiciona `faster-whisper`, `coqui-tts`, `torch`,
  `torchaudio`, com nota explícita para instalar o `torch` com a wheel CUDA
  certa **antes** do resto (senão cai pra CPU-only e fica lento).

- **`tests/test_translation_dubbing.py`** e **`tests/test_dubbing_endpoint.py`**
  (novos) — cobrem o pipeline completo (mockando whisper/XTTS, Ollama via
  `httpx.MockTransport`, sem rede), erro em cascata com unload garantido,
  normalização de idioma, validação do `DubbingRequest`, e o roteamento do
  endpoint por `dubbing_mode` (422 com hint, 400 sem `voice_id`, 400 modo
  inválido, 400 extensão inválida, 400 arquivo vazio, 200 caminho default).

## Testes rodados agora

```
12 passed, 4 warnings in 0.45s
```

(os 4 warnings são deprecations pré-existentes do FastAPI/Starlette
— `on_event`, não relacionadas a esta mudança.)

**Nota:** os testes rodaram com `faster-whisper`/`coqui-tts`/`torch` **não
instalados** (ambiente sem GPU disponível aqui) — `whisper_stt` e
`xtts_provider` foram mockados nos testes do pipeline. O comportamento de
"pacote ausente vira erro claro em vez de traceback cru" foi validado
diretamente (`test_translation_dubbing.py`, chamada sem mock).
**Isto NÃO testa o XTTS/whisper reais** — só a orquestração. Rode
`pytest tests/` de novo na sua máquina, com as libs instaladas, para validar
a inferência de verdade.

## Suposições e itens NÃO verificados (não testei na sua máquina)

1. **Qualidade da clonagem de voz do XTTS v2** com o `speaker_wav` sendo o
   áudio inteiro enviado (não um clipe curto e limpo) — a documentação do
   XTTS recomenda uma referência de alguns segundos, sem ruído/música de
   fundo. Se o áudio de entrada for longo ou ruidoso, pode valer a pena
   cortar um trecho limpo antes de usar como `speaker_wav`. Não implementei
   esse corte — não sei se é necessário no seu caso de uso real.
2. **Tamanho do modelo whisper (`small`)** — é meu chute de equilíbrio
   ingles/velocidade/VRAM para uma 3050 6GB rodando sequencialmente com
   XTTS; não medi latência real. Ajustável via `WHISPER_MODEL_SIZE`.
3. **VRAM do XTTS v2 sozinho** — não tenho o número exato para sua GPU/driver;
   a disciplina de load/unload sequencial (nunca dois modelos pesados
   residentes) devia ser suficiente numa 6GB, mas não medi.
4. **Tempo de carregamento do XTTS por job** (~10-20s é uma estimativa comum
   pra esse modelo, não medi) — como o modelo é descarregado após cada job
   (mesma disciplina do Ollama), cada dublagem paga esse custo de novo. Se
   virar um problema real de latência, dá pra revisitar (ex: manter XTTS
   residente e mover o Whisper pra CPU sempre).
5. **`torch`/`torchaudio`**: não fixei a wheel CUDA no `requirements.txt`
   porque depende do seu driver NVIDIA — instale ela primeiro seguindo o
   comentário deixado no arquivo, antes de rodar `pip install -r requirements.txt`.

## Ainda pendente (não fiz nesta rodada, para manter o diff revisável)

- **Objetivo 1** (extrair dublagem do `main.py` pra um `APIRouter`).
- **Objetivo 2** (upload do FastAPI em streaming pra arquivo temporário em
  vez de `file.read()` inteiro em RAM, TTL de `generated_audio`).
- **Frontend (`ollama-web`)** — ainda não recebi `lib/nexusBridge.ts`,
  `components/AudioDubber.tsx`, `lib/settings.ts`, `next.config.js`,
  `app/page.tsx`. Sem esses arquivos não dá pra mexer nos objetivos 5 e 6
  (UI precisa expor `dubbing_mode`/`source_language`, parar de prometer
  "tradução" quando o modo antigo for escolhido, etc.).

## Arquivos entregues

- `nexus-bridge-backend-updated.zip` — projeto completo do backend com as
  mudanças aplicadas (inclui `tests/`).
- `CHANGES.diff` — diff unificado só dos arquivos alterados (não inclui os
  3 arquivos novos, que estão íntegros no zip).
