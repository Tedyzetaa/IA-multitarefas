"use client";

import { Loader2, AlertTriangle, ImageIcon, Wand2 } from "lucide-react";
import { ImageGeneration, JobStatus } from "@/lib/types";

// Cobre os estados que o pipeline de imagem (t2i/i2i via ComfyUI) de fato
// emite. Os estados "refining_prompt"/"unloading_llm"/"generating_video" são
// específicos do pipeline de vídeo e nunca deveriam chegar aqui -- mas como
// JobStatus é compartilhado (ver lib/types.ts), tratamos qualquer status
// desconhecido com um rótulo genérico em vez de estourar em runtime.
const STATUS_LABEL: Partial<Record<JobStatus, string>> = {
  queued: "Na fila...",
  generating_image: "Gerando imagem (ComfyUI)...",
  completed: "Concluído",
  failed: "Falhou",
};

export default function ImageCard({ image }: { image: ImageGeneration }) {
  const modeLabel = image.mode === "i2i" ? "image-to-image" : "text-to-image";

  if (image.status === "completed" && image.url) {
    return (
      <div className="w-full max-w-sm">
        <div className="relative w-full max-w-sm mt-3 overflow-hidden rounded-xl bg-surface-light-sunken dark:bg-surface-dark-sunken">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={image.prompt}
            className="w-full h-auto rounded-xl border border-border-light dark:border-border-dark"
          />
        </div>
        <p className="mt-1.5 text-xs text-ink-muted flex items-center gap-1.5">
          {image.mode === "i2i" ? <Wand2 size={12} /> : <ImageIcon size={12} />}
          Gerado via ComfyUI ({modeLabel})
        </p>
      </div>
    );
  }

  if (image.status === "failed") {
    return (
      <div className="flex items-start gap-2 max-w-sm p-3 rounded-xl border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 text-sm">
        <AlertTriangle size={16} className="shrink-0 mt-0.5 text-red-500" />
        <div className="min-w-0">
          <p className="font-medium text-red-600 dark:text-red-400">Falha ao gerar imagem</p>
          {image.error && (
            <p className="text-xs text-red-500/80 mt-1 break-words">{image.error}</p>
          )}
        </div>
      </div>
    );
  }

  // queued / generating_image / qualquer status intermediário desconhecido
  return (
    <div className="flex items-center gap-2 max-w-sm p-3 rounded-xl border border-border-light dark:border-border-dark bg-surface-light-sunken dark:bg-surface-dark-sunken text-sm">
      <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
      <span className="text-ink-light dark:text-ink-dark">
        {STATUS_LABEL[image.status] ?? "Processando..."}
      </span>
    </div>
  );
}
