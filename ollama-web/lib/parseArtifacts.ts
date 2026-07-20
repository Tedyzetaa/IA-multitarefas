import { Artifact } from "./types";

/**
 * Heurística para decidir se um bloco de código merece virar um "Artefato"
 * (painel lateral), em vez de ficar embutido no fluxo do chat — igual ao
 * comportamento do Claude.ai:
 *   - mais de N linhas, OU
 *   - linguagem "estrutural" (html, jsx/tsx, python, componente completo)
 */
const MIN_LINES_FOR_ARTIFACT = 15;

const STRUCTURAL_LANGS = new Set([
  "html",
  "jsx",
  "tsx",
  "javascript",
  "typescript",
  "python",
  "vue",
  "svelte",
]);

interface RawCodeBlock {
  language: string;
  code: string;
  startIndex: number;
  endIndex: number;
}

const FENCE_RE = /```(\w+)?\n([\s\S]*?)```/g;

export function extractCodeBlocks(markdown: string): RawCodeBlock[] {
  const blocks: RawCodeBlock[] = [];
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(markdown)) !== null) {
    blocks.push({
      language: (match[1] || "text").toLowerCase(),
      code: match[2].replace(/\n$/, ""),
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return blocks;
}

function guessTitle(language: string, code: string): string {
  const firstLine = code.split("\n").find((l) => l.trim().length > 0) ?? "";
  const fnMatch = firstLine.match(/(?:function|const|class)\s+([A-Za-z0-9_]+)/);
  if (fnMatch) return fnMatch[1];
  const ext: Record<string, string> = {
    python: "script.py",
    javascript: "script.js",
    typescript: "script.ts",
    tsx: "component.tsx",
    jsx: "component.jsx",
    html: "index.html",
    css: "styles.css",
    json: "data.json",
    bash: "script.sh",
  };
  return ext[language] ?? `snippet.${language}`;
}

/**
 * Varre o texto completo de uma mensagem e retorna os blocos que devem
 * virar Artefatos, já com metadados prontos para o painel lateral.
 */
export function findArtifactCandidates(
  markdown: string,
  messageId: string
): Artifact[] {
  const blocks = extractCodeBlocks(markdown);
  const artifacts: Artifact[] = [];

  blocks.forEach((block, i) => {
    const lineCount = block.code.split("\n").length;
    const isStructural = STRUCTURAL_LANGS.has(block.language);
    const qualifies = lineCount >= MIN_LINES_FOR_ARTIFACT || (isStructural && lineCount >= 8);

    if (qualifies) {
      artifacts.push({
        id: `${messageId}-artifact-${i}`,
        language: block.language,
        code: block.code,
        title: guessTitle(block.language, block.code),
        messageId,
      });
    }
  });

  return artifacts;
}
