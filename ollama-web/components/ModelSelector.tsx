"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { fetchOllamaModels } from "@/hooks/useOllamaStream";

interface ModelSelectorProps {
  selectedModel: string;
  onChange: (model: string) => void;
}

export default function ModelSelector({
  selectedModel,
  onChange,
}: ModelSelectorProps) {
  const [models, setModels] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchOllamaModels();
        if (cancelled) return;
        const names = list.map((m) => m.name);
        setModels(names);
        if (names.length > 0 && !selectedModel) onChange(names[0]);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-ink-light dark:text-ink-dark hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
      >
        <Cpu size={14} className="text-ink-muted" />
        <span className="font-medium">
          {loading ? "Carregando..." : selectedModel || "Nenhum modelo"}
        </span>
        <ChevronDown size={14} className="text-ink-muted" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full mt-1 w-64 z-20 rounded-lg border border-border-light dark:border-border-dark bg-surface-light-raised dark:bg-surface-dark-raised shadow-lg overflow-hidden">
            {error && (
              <p className="px-3 py-2 text-xs text-red-500">
                {error}. Verifique se o Ollama está rodando em
                127.0.0.1:11434.
              </p>
            )}
            {!error && models.length === 0 && !loading && (
              <p className="px-3 py-2 text-xs text-ink-muted">
                Nenhum modelo instalado.
              </p>
            )}
            {models.map((m) => (
              <button
                key={m}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors ${
                  m === selectedModel
                    ? "text-accent font-medium"
                    : "text-ink-light dark:text-ink-dark"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
