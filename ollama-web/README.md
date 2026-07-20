# Ollama Chat — Clone da UI do Claude

Interface de chat SPA, visualmente inspirada no Claude.ai, conectada
diretamente a uma instância local do [Ollama](https://ollama.com) via
`fetch` nativo (sem SDKs de streaming).

## 1. Arquitetura de pastas

```
claude-ollama-clone/
├── app/
│   ├── layout.tsx        # <html>/<body>, fontes, script anti-flash de tema
│   ├── page.tsx          # Orquestrador: estado global, conversas, geração
│   └── globals.css       # Tailwind + scrollbar + acessibilidade
├── components/
│   ├── Sidebar.tsx        # Histórico agrupado por tempo, novo chat
│   ├── ChatArea.tsx        # Header + lista de mensagens + input
│   ├── Message.tsx         # Renderização de markdown por mensagem
│   ├── CodeBlock.tsx       # Bloco de código inline (copiar / abrir artefato)
│   ├── ArtifactPanel.tsx   # Painel lateral (split-view) de artefatos
│   ├── ModelSelector.tsx   # Dropdown dinâmico (GET /api/tags)
│   └── InputBox.tsx        # Textarea auto-resize + botão enviar/parar
├── hooks/
│   └── useOllamaStream.ts  # Fetch + ReadableStream + NDJSON + AbortController
├── lib/
│   ├── types.ts             # Tipos compartilhados
│   └── parseArtifacts.ts    # Heurística de detecção de "artefatos"
└── package.json
```

**Por que essa divisão?** `page.tsx` é o único lugar que conhece o estado
completo (conversas, mensagens, artefatos) e o hook de streaming — todos os
componentes abaixo dele são "burros" (recebem props, disparam callbacks),
o que facilita testar e trocar de biblioteca de estado (Zustand/Redux) no
futuro sem tocar na UI.

## 2. Como rodar

```bash
npm install
npm run dev
```

Abra `http://localhost:3000`.

### Pré-requisito: CORS do Ollama

Por padrão o Ollama bloqueia requisições de origens diferentes de
`localhost`/`127.0.0.1` dependendo da porta. Se o front-end (porta 3000)
não conseguir falar com o Ollama (porta 11434), rode o Ollama com:

```bash
OLLAMA_ORIGINS="http://localhost:3000" ollama serve
```

(No Windows/macOS via variável de ambiente do sistema antes de abrir o
app do Ollama.)

Se quiser apontar para outro host/porta, crie um `.env.local`:

```
NEXT_PUBLIC_OLLAMA_URL=http://127.0.0.1:11434
```

## 3. Decisões técnicas relevantes

- **Streaming**: `useOllamaStream` lê `response.body.getReader()` chunk a
  chunk, decodifica com `TextDecoder`, e faz o parsing de NDJSON mantendo
  um buffer para linhas que atravessam a fronteira de dois chunks TCP
  (isso é a causa mais comum de "JSON.parse quebrado" em integrações com
  Ollama feitas às pressas).
- **Cancelamento**: um único `AbortController` por requisição ativa. Ao
  clicar em "Stop", o texto acumulado até aquele ponto é preservado na
  mensagem (comportamento igual ao Claude.ai).
- **Artefatos**: heurística simples em `parseArtifacts.ts` — blocos de
  código com 15+ linhas, ou 8+ linhas em linguagens "estruturais" (html,
  tsx, python etc.), viram candidatos a artefato. Cada bloco de código
  dentro do `Message.tsx` verifica se seu conteúdo bate com algum artefato
  já extraído e, se sim, ganha o botão "Abrir artefato".
- **Persistência**: conversas ficam em `localStorage` (chave
  `ollama-chat-conversations`). Trivial trocar por IndexedDB ou uma API
  própria depois, já que tudo passa por `updateConversation()`.
- **Syntax highlighting**: `rehype-highlight` + tema `highlight.js`
  (adicione o CSS do tema de sua preferência em `globals.css`, ex.
  `github-dark`/`github`, ou implemente troca dinâmica conforme o tema
  claro/escuro).

## 4. Extensões sugeridas (fora do escopo do desafio)

- Trocar `localStorage` por rota `/api/conversations` com um banco real.
- Upload de anexos (o botão já existe, falta o handler de `input[type=file]`).
- Web Search / RAG local antes de montar o array `messages` enviado ao Ollama.
