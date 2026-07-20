# Nexus-Bridge

Orquestrador local que conecta **Ollama** (refinamento de prompt via LLM) e
**Fooocus** (geração de imagem) num pipeline único, pensado para rodar num
notebook com VRAM limitada (referência: i5-13420H, 16GB RAM, RTX 3050 6GB).

## Por que essa arquitetura resolve o problema de VRAM

Numa GPU de 6GB, Ollama (modelo Qwen2.5-Coder) e Fooocus (SDXL/SD) **não
cabem em VRAM ao mesmo tempo** com folga de segurança. Duas camadas resolvem isso:

1. **Fila interna com worker único** (`queue_manager.py`): usa `asyncio.Queue`
   + um único worker assíncrono. Mesmo que dois usuários disparem requisições
   simultâneas, apenas **um job por vez** é processado do início ao fim.
2. **Unload explícito do LLM antes da imagem** (`orchestrator.py`): depois que
   o Ollama devolve o prompt refinado, o sistema chama `clear_context()`, que
   envia `keep_alive=0` ao Ollama — isso descarrega o modelo da VRAM
   **antes** de disparar o Fooocus. Sem essa etapa, os dois processos
   disputariam a mesma memória e você veria erros como `CUDA out of memory`
   ou `alloc_tensor`.
3. **Guarda de recursos com retry gracioso** (`resource_manager.py`): se
   `pynvml` detectar VRAM livre abaixo da margem de segurança, ou se o
   Fooocus retornar um erro de OOM, o sistema automaticamente reduz `steps`
   e resolução e tenta novamente (até `MAX_RETRIES_ON_OOM` vezes) antes de
   desistir.

## Arquitetura (módulos trocáveis)

```
backend/app/
├── providers/
│   ├── base.py              <- contratos abstratos (LLMProvider, ImageProvider)
│   ├── ollama_provider.py   <- implementação concreta para Ollama
│   └── fooocus_provider.py  <- implementação concreta para Fooocus
├── services/
│   └── orchestrator.py      <- CORE: pipeline LLM -> unload -> Imagem. Nunca muda.
├── queue_manager.py         <- fila assíncrona (troque por Redis/arq se precisar escalar)
├── resource_manager.py      <- guarda de VRAM + retry
├── status_manager.py        <- estado ready/busy/offline exposto ao frontend
├── models.py / config.py
└── main.py                  <- FastAPI, endpoint gateway /api/generate
```

**Para trocar o modelo do Ollama:** edite `OLLAMA_MODEL` no `.env`.

**Para trocar o gerador de imagem** (ex: sair do Fooocus e ir para ComfyUI):
crie `app/providers/comfyui_provider.py` implementando `ImageProvider` (mesma
interface: `generate()` e `health_check()`), e troque uma linha em
`main.py`:

```python
image_provider = ComfyUIProvider()  # antes: FooocusProvider()
```

O `orchestrator.py` e o `queue_manager.py` **não precisam ser tocados** —
esse é o ponto do Dependency Injection usado aqui.

**Para escalar além de um notebook:** troque `QueueManager` (asyncio.Queue)
por uma implementação com Redis + `arq`, mantendo a mesma interface pública
(`enqueue`, `get_job`, `list_jobs`).

## Setup

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env      # ajuste hosts/modelo se necessário
uvicorn app.main:app --reload --port 8000
```

Pré-requisitos rodando localmente:
- Ollama em `http://127.0.0.1:11434` com o modelo `qwen2.5-coder:7b` puxado
  (`ollama pull qwen2.5-coder:7b`)
- Fooocus com API ativada em `http://127.0.0.1:7865`
  (`python entry_with_update.py --api`)

`pynvml` é opcional: se não houver GPU NVIDIA acessível (ou o driver não
expuser NVML), o sistema simplesmente ignora a checagem preventiva de VRAM e
segue confiando apenas na detecção de erro OOM vinda do Fooocus.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Acesse `http://localhost:5173`. O frontend consome a API em
`http://127.0.0.1:8000` por padrão (ajustável via `VITE_API_BASE`).

## Endpoints principais

| Método | Rota                  | Descrição                                      |
|--------|------------------------|-------------------------------------------------|
| POST   | `/api/generate`        | Gateway único: recebe `user_prompt`, enfileira |
| GET    | `/api/jobs/{job_id}`   | Status/resultado do job (para polling)         |
| GET    | `/api/gallery`         | Histórico paginado (lazy-load)                 |
| GET    | `/api/status`          | Status do Ollama/Fooocus + tamanho da fila     |

## Fluxo de um job

```
QUEUED -> REFINING_PROMPT (Ollama) -> UNLOADING_LLM (libera VRAM)
        -> GENERATING_IMAGE (Fooocus) -> COMPLETED | FAILED
```

Cada estágio é refletido em tempo real no frontend via polling (1.5s
enquanto o job está ativo, 3s para o status geral do sistema).
