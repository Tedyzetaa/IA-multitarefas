"use client";

import { useCallback, useState } from "react";
import { previewAudioDubbing, synthesizeAudioDubbing } from "@/lib/nexusBridge";
import { toast } from "@/lib/toast";
import {
  AudioDubbingPreviewResult,
  AudioDubbingResult,
  AudioDubbingStatus,
} from "@/lib/types";

/**
 * Fluxo revisável de dublagem: transcribeAndTranslate() (passo 1) devolve o
 * texto traduzido para o usuário CORRIGIR na caixa de texto; só depois disso
 * synthesize() (passo 2) gera o áudio de fato, clonando a voz de referência
 * enviada ou (se nenhuma for enviada) a voz do áudio original.
 */
export function useAudioDubbing() {
  const [status, setStatus] = useState<AudioDubbingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AudioDubbingPreviewResult | null>(null);
  const [result, setResult] = useState<AudioDubbingResult | null>(null);

  const isTranscribing = status === "transcribing";
  const isSynthesizing = status === "synthesizing";
  const isProcessing = isTranscribing || isSynthesizing;

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setPreview(null);
    setResult(null);
  }, []);

  /** Passo 1: transcreve + traduz. Não sintetiza -- só popula `preview`. */
  const transcribeAndTranslate = useCallback(
    async (file: File, sourceLanguage: string, targetLanguage: string) => {
      setStatus("transcribing");
      setError(null);
      setResult(null);
      setPreview(null);

      try {
        const response = await previewAudioDubbing(file, sourceLanguage, targetLanguage);
        setPreview(response);
        setStatus("reviewing");
        toast("Transcrição pronta. Revise a tradução antes de sintetizar.", "success");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Não foi possível transcrever o áudio.";
        setStatus("error");
        setError(message);
        toast(message, "error");
      }
    },
    []
  );

  /** Passo 2: sintetiza o texto (já revisado pelo usuário) com XTTS v2. */
  const synthesize = useCallback(
    async (editedText: string, targetLanguage: string, referenceVoice?: File | null) => {
      if (!preview) {
        toast("Transcreva o áudio antes de sintetizar.", "error");
        return;
      }
      if (!editedText.trim()) {
        toast("O texto traduzido está vazio.", "error");
        return;
      }

      setStatus("synthesizing");
      setError(null);

      try {
        const response = await synthesizeAudioDubbing(
          preview.sessionId,
          editedText,
          targetLanguage,
          referenceVoice
        );

        if (response.status === "error" || response.error) {
          throw new Error(response.error ?? "Falha ao sintetizar o áudio.");
        }

        setResult(response);
        setStatus("success");
        toast("Dublagem concluída com sucesso.", "success");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Não foi possível sintetizar o áudio.";
        setStatus("error");
        setError(message);
        toast(message, "error");
      }
    },
    [preview]
  );

  return {
    status,
    isProcessing,
    isTranscribing,
    isSynthesizing,
    error,
    preview,
    result,
    transcribeAndTranslate,
    synthesize,
    reset,
  };
}
