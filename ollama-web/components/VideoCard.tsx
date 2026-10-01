"use client";

import { Loader2, AlertTriangle, Film } from "lucide-react";
import { VideoGeneration, JobStatus } from "@/lib/types";

// Partial + fallback (em vez de Record completo): JobStatus agora é
// compartilhado com o pipeline de imagem (ver lib/types.ts), então este
// card não precisa conhecer o rótulo de "generating_image" -- só os
// estados que o pipeline de vídeo de fato emite.
const STATUS_LABEL: Partial<Record<JobStatus, string>> = {
  queued: "Na fila...",
  refining_prompt: "Refinando o prompt (Ollama)...",
  unloading_llm: "Liberando VRAM do LLM...",
  generating_video: "Gerando vídeo (LTX-Video)... isso pode levar alguns minutos",
  completed: "Concluído",
  failed: "Falhou",
};

export default function VideoCard({ video }: { video: VideoGeneration }) {
  if (video.status === "completed" && video.url) {
    return (
      <div className="w-full max-w-full">
        <div className="relative w-full max-w-full mt-3 overflow-hidden rounded-xl bg-black aspect-video">
          <video
            controls
            src={video.url}
            className="absolute inset-0 w-full h-full object-contain"
          />
        </div>
        <p className="mt-1.5 text-xs text-ink-muted flex items-center gap-1.5">
          <Film size={12} />
          Gerado via LTX-Video
        </p>
      </div>
    );
  }

  if (video.status === "failed") {
    return (
      <div className="flex items-start gap-2 max-w-sm p-3 rounded-xl border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 text-sm">
        <AlertTriangle size={16} className="shrink-0 mt-0.5 text-red-500" />
        <div className="min-w-0">
          <p className="font-medium text-red-600 dark:text-red-400">Falha ao gerar vídeo</p>
          {video.error && (
            <p className="text-xs text-red-500/80 mt-1 break-words">{video.error}</p>
          )}
        </div>
      </div>
    );
  }

  // queued / refining_prompt / unloading_llm / generating_video
  return (
    <div className="flex items-center gap-2 max-w-sm p-3 rounded-xl border border-border-light dark:border-border-dark bg-surface-light-sunken dark:bg-surface-dark-sunken text-sm">
      <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
      <span className="text-ink-light dark:text-ink-dark">
        {STATUS_LABEL[video.status] ?? "Processando..."}
      </span>
    </div>
  );
}
