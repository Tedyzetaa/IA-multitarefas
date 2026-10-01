# Melhorias aplicadas

## 1. Colar imagens direto no chat (Ctrl+V)
`components/InputBox.tsx` agora escuta o evento `onPaste` da caixa de texto.
Se a área de transferência contiver um arquivo (print/screenshot copiado),
ele vira anexo automaticamente — sem precisar clicar no clipe. Texto colado
continua funcionando normalmente.

## 2. Arrastar e soltar arquivos (drag & drop)
`components/ChatArea.tsx` escuta `dragenter/dragover/drop` na área inteira
do chat (não só num botão), com um overlay visual ("Solte os arquivos
aqui") enquanto o usuário arrasta. Os arquivos soltos vão para o mesmo
pipeline de validação/upload que já existia (`lib/attachments.ts`).

## 3. Banco de dados interno (IndexedDB) — `lib/db.ts`
Trocado `localStorage` por **IndexedDB**:
- `localStorage` guarda tudo como uma única string, com limite de
  ~5-10MB, e cada salvamento serializa o histórico inteiro (trava a UI
  conforme anexos em base64 se acumulam).
- IndexedDB é assíncrono, tem limite muito maior, e permite gravar/ler
  **uma conversa por vez** em vez do dataset inteiro — muito mais rápido
  e resiliente com anexos de imagem.
- Migração automática: se havia histórico salvo no formato antigo, ele é
  importado para o IndexedDB na primeira vez que o app abre, sem o
  usuário perceber ou perder nada.
- Cada conversa agora é salva individualmente (debounce de 400ms por
  conversa), não mais o array inteiro a cada alteração.

## 4. Outras melhorias de UX

- **Buscar conversas** na barra lateral (por título ou conteúdo das mensagens).
- **Renomear conversa** com duplo clique no título (ou pelo ícone de lápis).
- **Editar mensagem enviada**: clique em "Editar" numa mensagem sua, ajuste
  o texto e reenvie — o histórico depois dela é descartado e a resposta é
  regenerada (igual ao Claude.ai).
- **Copiar / excluir mensagens** individualmente, com botão de feedback.
- **Auto-scroll inteligente**: se você rolar para cima durante uma resposta
  em streaming, o chat para de "puxar" a tela sozinho. Aparece um botão
  flutuante "Ir para o fim" para voltar quando quiser.
- **Notificações (toasts)** para erros (arquivo inválido, falha ao salvar,
  falha ao copiar) e confirmações — nada mais falha em silêncio.
- **Painel de Configurações** (botão na barra lateral):
  - Tema claro/escuro/sistema com alternância manual (antes só seguia o SO).
  - Endereço do servidor Ollama configurável direto na UI.
  - Prompt de sistema padrão + controle de temperatura (criatividade).
  - Exportar todo o histórico em `.json` (backup manual).
  - Apagar todo o histórico (com confirmação em duas etapas).
- **Aviso quando nenhum modelo está selecionado**, em vez de deixar o
  usuário mandar mensagem no vazio.

## Compatibilidade
Nenhuma dependência nova foi adicionada — tudo usa APIs nativas do
navegador (IndexedDB, Clipboard, Drag & Drop). O projeto continua em
Next.js 14 + React 18 + Tailwind, sem quebrar nada do que já existia
(streaming, artefatos, anexos de PDF/ZIP/imagem).

Testado com `npx next build` — build de produção passa sem erros de tipo.

## Ideias para uma próxima rodada (não implementadas ainda)
- Múltiplos perfis de "system prompt" salvos (não só um padrão global).
- Busca full-text mais avançada (destacar trecho encontrado).
- Atalhos de teclado globais (Ctrl+K novo chat, Ctrl+/ busca).
- Suporte a múltiplas abas sincronizadas (BroadcastChannel no lib/db.ts).
- Contagem de tokens aproximada por conversa.
