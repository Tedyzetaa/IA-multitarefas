# Nexus-Bridge — pipeline de dublagem local (Whisper -> Ollama -> XTTS v2) quebrando

## Contexto do projeto

- App: **Nexus-Bridge** (FastAPI, `C:\CyberVerse\IA\nexus-bridge`), rodado via `venv\Scripts\activate.bat` + Uvicorn (`http://127.0.0.1:8000`).
- Fluxo relevante: `translation_dubbing_provider.py` recebe um `.mp3`, chama:
  1. `whisper_stt.py` — transcrição com **faster-whisper** (backend **ctranslate2**), `device="cuda"`, `compute_type="float16"`, modelo `small`.
  2. Ollama (`http://127.0.0.1:11434`) — tradução en -> pt-BR.
  3. `xtts_provider.py` — síntese com **XTTS v2** (pacote `coqui-tts`, sobre **torch**), clonando a voz do áudio original.
- Whisper e XTTS rodam **no mesmo processo** Python (mesmo worker da fila), sequencialmente. Cada um libera o modelo (`unload()`) depois de usar, mas isso não descarrega DLLs nativas do processo.
- Ambiente: **Windows**, GPU **RTX 3050**, Python **3.11**, driver com CUDA runtime relatado **12.1**.

### `requirements.txt` (trecho relevante, estado ANTES de qualquer alteração)

```
torch==2.5.1          # instalado com wheel cu121 (--index-url https://download.pytorch.org/whl/cu121)
torchaudio==2.5.1
transformers==4.57.6
faster-whisper==1.2.1
coqui-tts==0.27.5
ctranslate2==4.8.2
```

## Linha do tempo dos erros

### Erro 1 — `cudnnGetLibConfig` (Windows: "Error code 127")

Log (resumo): faster-whisper transcreve com sucesso em CUDA, descarrega o modelo, e então o carregamento do XTTS v2 falha:

```
Could not load symbol cudnnGetLibConfig. Error code 127
```

**Diagnóstico:** `torch==2.5.1+cu121` fixa uma versão exata e antiga do cuDNN 9 via pip (`nvidia-cudnn-cu12==9.1.0.70`). `ctranslate2==4.8.2` também carrega cuDNN 9 em tempo de execução (dlopen/`LoadLibraryA`, não embutido no wheel), mas precisa de uma função (`cudnnGetLibConfig`) que só existe a partir do **cuDNN 9.3**. Como os dois processos (whisper via ctranslate2, depois XTTS via torch) carregam a mesma DLL nomeada por SONAME no mesmo processo, há conflito de versão do cuDNN 9.

### Tentativa 1 (❌ piorou) — downgrade do `ctranslate2` para `4.4.0`

Baseado na tabela de compatibilidade conhecida do `faster-whisper` (torch `+cu121` ↔ `ctranslate2<=4.4.0`), fizemos:

```
pip uninstall ctranslate2 -y
pip install ctranslate2==4.4.0
```

Resultado: novo erro, processo fecha:

```
Could not locate cudnn_ops_infer64_8.dll. Please make sure it is in your library path!
```

**Motivo:** `ctranslate2==4.4.0` é da geração que espera **cuDNN 8** (não 9) instalado no sistema. O ambiente só tem cuDNN 9 (trazido pelo torch), então a DLL v8 não existe em lugar nenhum — precisaria instalar cuDNN 8.9.x para CUDA 12 manualmente (fora do pip), o que é mais complexo. **Essa rota foi abandonada.**

### Tentativa 2 (aplicada, resultado ainda não confirmado) — manter `ctranslate2==4.8.2` e atualizar só o cuDNN

```
pip uninstall ctranslate2 -y
pip install ctranslate2==4.8.2
pip install --upgrade nvidia-cudnn-cu12
```

Ideia: manter torch e ctranslate2 nas versões atuais, só levar o pacote `nvidia-cudnn-cu12` (que ambos carregam em runtime) para uma build ≥ 9.3 que tenha `cudnnGetLibConfig`, mantendo compatibilidade de ABI com torch 2.5.1.

Recomendação pendente de aplicar no `requirements.txt`, para não perder o pin depois de uma reinstalação limpa:

```
ctranslate2==4.8.2
nvidia-cudnn-cu12>=9.3.0  # torch 2.5.1 pede 9.1.0.70 (sem cudnnGetLibConfig); versão mais nova exigida pelo ctranslate2 4.8.2
```

### Erro 3 (atual, SEM LOG ainda) — HTTP 500 em `/api/v1/dubbing/process`

- Usuário reportou no frontend: `nexus-bridge respondeu 500 em /api/v1/dubbing/process: Internal Server Error`.
- O processo do Nexus-Bridge **fechou** (a janela/console encerrou) — não temos o traceback completo ainda.
- Não sabemos se é uma recorrência do problema de cuDNN, um novo problema (VRAM insuficiente, path de arquivo, timeout do Ollama, exceção não tratada em outro ponto do pipeline) ou algo desconectado (ex.: falha antes mesmo de chegar no whisper).

## Estado atual / o que falta

1. **Precisamos do log completo do console** do Nexus-Bridge entre o momento em que o job de dublagem é recebido e o momento em que o processo fecha. Sem isso não dá pra saber se é:
   - o mesmo conflito de cuDNN reaparecendo em outro símbolo (ex.: `cudnn_ops64_9.dll`, `cudnn_cnn64_9.dll`);
   - falta de VRAM (RTX 3050 tem pouca VRAM — Whisper `small` fp16 + XTTS v2 carregados/descarregados em sequência no mesmo processo pode estourar);
   - uma exceção Python comum não relacionada a CUDA (path inválido, arquivo, parsing, etc.).
2. Se a janela do console fecha sozinha antes de dar pra ler o traceback, sugerido rodar sem `start.bat`/`start.vbs` (ex.: `python -m uvicorn app.main:app --host 127.0.0.1 --port 8000` diretamente em um terminal que não feche) para capturar a saída completa, ou redirecionar para arquivo (`... > nexus.log 2>&1`).
3. Confirmar se a Tentativa 2 (upgrade do `nvidia-cudnn-cu12`) sequer chegou a ser testada com sucesso antes desse erro 500 — ou se o 500 é consequência direta dela.

## Arquivos relevantes no projeto (dentro do zip fornecido)

- `app/providers/whisper_stt.py`
- `app/providers/xtts_provider.py`
- `app/providers/translation_dubbing_provider.py`
- `requirements.txt`
- `.env` / `.env.example`
- `app/main.py` (não inspecionado ainda em detalhe)

## Próximo passo pedido ao usuário

Colar o log completo do console (ou anexar `nexus.log`) do momento do upload até o processo fechar, para dar continuidade ao diagnóstico do erro 500.