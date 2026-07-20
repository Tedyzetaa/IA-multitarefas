"use client";

import { useState } from "react";
import { Copy, Check, PanelRightOpen } from "lucide-react";

interface CodeBlockProps {
  language: string;
  code: string;
  /** true quando este bloco também existe como Artefato no painel lateral */
  isArtifact?: boolean;
  onOpenArtifact?: () => void;
}

export default function CodeBlock({
  language,
  code,
  isArtifact,
  onOpenArtifact,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-border-light dark:border-border-dark">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-light-sunken dark:bg-surface-dark-sunken text-xs">
        <span className="text-ink-muted uppercase tracking-wide">
          {language || "text"}
        </span>
        <div className="flex items-center gap-1">
          {isArtifact && (
            <button
              onClick={onOpenArtifact}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-light-raised dark:hover:bg-surface-dark-raised text-ink-muted transition-colors"
            >
              <PanelRightOpen size={13} />
              Abrir artefato
            </button>
          )}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-light-raised dark:hover:bg-surface-dark-raised text-ink-muted transition-colors"
          >
            {copied ? (
              <>
                <Check size={13} className="text-green-600" /> Copiado
              </>
            ) : (
              <>
                <Copy size={13} /> Copiar
              </>
            )}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-3 text-sm font-mono bg-surface-light-raised dark:bg-surface-dark-raised">
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  );
}
