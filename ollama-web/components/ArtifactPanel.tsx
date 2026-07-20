"use client";

import { useState } from "react";
import { X, Copy, Check, Code2, Download } from "lucide-react";
import { Artifact } from "@/lib/types";

interface ArtifactPanelProps {
  artifact: Artifact | null;
  artifacts: Artifact[];
  onSelect: (artifact: Artifact) => void;
  onClose: () => void;
}

/**
 * Painel lateral (split-view) que isola um bloco de código do fluxo do
 * chat — a "assinatura visual" do Claude. Ocupa a metade direita da tela
 * quando aberto; a área de chat encolhe automaticamente (ver page.tsx).
 */
export default function ArtifactPanel({
  artifact,
  artifacts,
  onSelect,
  onClose,
}: ArtifactPanelProps) {
  const [copied, setCopied] = useState(false);

  if (!artifact) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(artifact.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownload = () => {
    const blob = new Blob([artifact.code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.title;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside
      className="hidden lg:flex w-[45%] max-w-2xl shrink-0 flex-col
                 border-l border-border-light dark:border-border-dark
                 bg-surface-light-raised dark:bg-surface-dark-raised
                 animate-slideIn"
      aria-label="Painel de artefato"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border-light dark:border-border-dark">
        <div className="flex items-center gap-2 min-w-0">
          <Code2 size={16} className="text-accent shrink-0" />
          <span className="text-sm font-medium truncate text-ink-light dark:text-ink-dark">
            {artifact.title}
          </span>
          <span className="text-xs text-ink-muted uppercase shrink-0">
            {artifact.language}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-md hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
            title="Copiar código"
            aria-label="Copiar código"
          >
            {copied ? (
              <Check size={16} className="text-green-600" />
            ) : (
              <Copy size={16} className="text-ink-muted" />
            )}
          </button>
          <button
            onClick={handleDownload}
            className="p-1.5 rounded-md hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
            title="Baixar arquivo"
            aria-label="Baixar arquivo"
          >
            <Download size={16} className="text-ink-muted" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
            title="Fechar painel"
            aria-label="Fechar painel"
          >
            <X size={16} className="text-ink-muted" />
          </button>
        </div>
      </div>

      {/* Tabs — quando há mais de um artefato na conversa */}
      {artifacts.length > 1 && (
        <div className="flex gap-1 px-3 pt-2 overflow-x-auto border-b border-border-light dark:border-border-dark">
          {artifacts.map((a) => (
            <button
              key={a.id}
              onClick={() => onSelect(a)}
              className={`px-3 py-1.5 text-xs rounded-t-md whitespace-nowrap transition-colors ${
                a.id === artifact.id
                  ? "bg-surface-light-sunken dark:bg-surface-dark-sunken text-ink-light dark:text-ink-dark font-medium"
                  : "text-ink-muted hover:text-ink-light dark:hover:text-ink-dark"
              }`}
            >
              {a.title}
            </button>
          ))}
        </div>
      )}

      {/* Code content */}
      <div className="flex-1 overflow-auto">
        <pre className="p-4 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words text-ink-light dark:text-ink-dark">
          <code>{artifact.code}</code>
        </pre>
      </div>
    </aside>
  );
}
