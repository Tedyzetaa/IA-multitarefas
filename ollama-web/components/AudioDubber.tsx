"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  CheckCircle2,
  FileAudio,
  Languages,
  Loader2,
  Mic2,
  Music2,
  Sparkles,
  UploadCloud,
  Volume2,
  Wand2,
  X,
} from "lucide-react";
import { useAudioDubbing } from "@/hooks/useAudioDubbing";
import { loadSettings, saveSettings } from "@/lib/settings";
import { toast } from "@/lib/toast";
import { AudioDubbingSettings, AudioDubbingStatus, AudioTargetLanguage } from "@/lib/types";

const DEFAULT_SETTINGS: AudioDubbingSettings = {
  sourceLanguage: "en-US",
  targetLanguage: "pt-BR",
  voiceProvider: "elevenlabs",
  voiceId: "",
  stability: 0.72,
  similarityBoost: 0.88,
};

const waveformBars = [0.28, 0.4, 0.34, 0.68, 0.42, 0.75, 0.52, 0.88, 0.48, 0.32, 0.66, 0.58, 0.76, 0.4, 0.24, 0.62, 0.72, 0.54, 0.3, 0.78, 0.66, 0.38, 0.5, 0.81, 0.46, 0.32, 0.6, 0.84, 0.7, 0.42, 0.26, 0.58];

const languageOptions: { label: string; value: AudioTargetLanguage }[] = [
  { label: "Português (Brasil)", value: "pt-BR" },
  { label: "Inglês (EUA)", value: "en-US" },
  { label: "Espanhol", value: "es-ES" },
  { label: "Francês", value: "fr-FR" },
  { label: "Alemão", value: "de-DE" },
  { label: "Japonês", value: "ja-JP" },
];

const steps = [
  { id: "upload", label: "1. Upload" },
  { id: "review", label: "2. Revisão" },
  { id: "synthesize", label: "3. Síntese" },
] as const;

const STATUS_META: Record<
  AudioDubbingStatus,
  { label: string; tone: string; description: string; progress: number }
> = {
  idle: {
    label: "Disponível",
    tone: "border-border-light dark:border-border-dark text-ink-muted",
    description: "Envie um áudio para começar.",
    progress: 0,
  },
  transcribing: {
    label: "Transcrevendo",
    tone: "border-blue-300 bg-blue-500/10 text-blue-600 dark:text-blue-300",
    description: "Ouvindo o áudio e traduzindo o texto...",
    progress: 40,
  },
  reviewing: {
    label: "Revisão",
    tone: "border-violet-300 bg-violet-500/10 text-violet-600 dark:text-violet-300",
    description: "Revise a tradução abaixo antes de sintetizar.",
    progress: 55,
  },
  synthesizing: {
    label: "Sintetizando",
    tone: "border-amber-300 bg-amber-500/10 text-amber-600 dark:text-amber-300",
    description: "Clonando a voz e gerando o áudio final...",
    progress: 85,
  },
  success: {
    label: "Concluído",
    tone: "border-emerald-300 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    description: "Versão dublada pronta para revisão.",
    progress: 100,
  },
  error: {
    label: "Erro",
    tone: "border-red-300 bg-red-500/10 text-red-600 dark:text-red-300",
    description: "O processamento não pôde ser concluído.",
    progress: 0,
  },
};

function AudioBars({ active = false }: { active?: boolean }) {
  return (
    <div className="flex h-12 items-end gap-1.5">
      {waveformBars.map((bar, index) => (
        <span
          key={`${bar}-${index}`}
          className={active ? "block w-1.5 rounded-full bg-accent" : "block w-1.5 rounded-full bg-ink-muted/30 dark:bg-ink-dark/20"}
          style={{
            height: `${22 + bar * 38}px`,
            animationDelay: `${index * 80}ms`,
            animationDuration: `${700 + index * 60}ms`,
            animationName: active ? "pulse" : undefined,
            animationIterationCount: active ? "infinite" : "1",
            opacity: active ? 0.9 : 0.5,
          }}
        />
      ))}
    </div>
  );
}

const AUDIO_ACCEPT_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "audio/mp4",
  "audio/aac",
];

function isValidAudioFile(file: File): boolean {
  return AUDIO_ACCEPT_TYPES.includes(file.type) || /\.(mp3|wav|m4a|aac)$/i.test(file.name);
}

export default function AudioDubber() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);

  const {
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
  } = useAudioDubbing();

  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [referenceVoiceFile, setReferenceVoiceFile] = useState<File | null>(null);
  const [translatedText, setTranslatedText] = useState("");
  const [settings, setSettings] = useState<AudioDubbingSettings>(
    loadSettings().audioDubbing ?? DEFAULT_SETTINGS
  );

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Sincroniza a caixa de texto editável sempre que um novo preview chega
  // (nova transcrição) -- o usuário edita a PARTIR da tradução do Ollama.
  useEffect(() => {
    if (preview) setTranslatedText(preview.translatedText);
  }, [preview]);

  const currentMeta = STATUS_META[status];
  const activeStepIndex = preview ? 1 : selectedFile ? 0 : 0;
  const activeStep = steps[Math.min(activeStepIndex, steps.length - 1)];

  const comparisonAudio = useMemo(() => {
    if (result?.dubbedUrl) return result;
    return null;
  }, [result]);

  const handleFileSelect = (file?: File | null) => {
    if (!file) return;

    if (!isValidAudioFile(file)) {
      toast("Formato não suportado. Use MP3, WAV ou M4A.", "error");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast("Arquivo muito grande. Máximo de 25MB.", "error");
      return;
    }

    setSelectedFile(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setReferenceVoiceFile(null);
    reset();
    toast("Arquivo pronto. Clique em \"Transcrever e traduzir\".", "success");
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFileSelect(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    handleFileSelect(event.dataTransfer.files?.[0]);
  };

  const handleReferenceVoiceChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!isValidAudioFile(file)) {
      toast("Formato não suportado para a voz de referência. Use MP3, WAV ou M4A.", "error");
      return;
    }
    setReferenceVoiceFile(file);
  };

  const persistSettings = (next: AudioDubbingSettings) => {
    setSettings(next);
    saveSettings({ ...loadSettings(), audioDubbing: next });
  };

  const handleTranscribe = async () => {
    if (!selectedFile) {
      toast("Selecione um arquivo de áudio primeiro.", "error");
      return;
    }
    await transcribeAndTranslate(selectedFile, settings.sourceLanguage, settings.targetLanguage);
  };

  const handleSynthesize = async () => {
    await synthesize(translatedText, settings.targetLanguage, referenceVoiceFile);
  };

  const transcribeButtonLabel = isTranscribing ? "Transcrevendo..." : "Transcrever e traduzir";
  const synthesizeButtonLabel = isSynthesizing ? "Sintetizando..." : "Sintetizar com XTTS v2";

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="rounded-[28px] border border-border-light bg-surface-light-raised p-4 shadow-sm dark:border-border-dark dark:bg-surface-dark-raised md:p-6">
          <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-muted">
                Studio de áudio
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-ink-light dark:text-ink-dark">
                Dublagem com revisão
              </h2>
            </div>
            <div
              className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-xs font-medium ${currentMeta.tone}`}
            >
              <span className="h-2 w-2 rounded-full bg-current" />
              {currentMeta.label}
            </div>
          </div>

          <div className="mb-6 grid gap-2 rounded-[22px] border border-border-light bg-surface-light-sunken p-2 dark:border-border-dark dark:bg-surface-dark-sunken md:grid-cols-3">
            {steps.map((step, index) => {
              const isComplete = index < (preview ? 2 : selectedFile ? 1 : 0);
              const isCurrent = step.id === activeStep.id;

              return (
                <div
                  key={step.id}
                  className={[
                    "flex items-center justify-center rounded-xl border px-3 py-2.5 text-xs font-medium transition-all duration-200",
                    isCurrent
                      ? "border-accent bg-accent-soft text-accent dark:bg-accent/10"
                      : isComplete
                        ? "border-emerald-200 bg-emerald-500/10 text-emerald-600 dark:border-emerald-900 dark:text-emerald-300"
                        : "border-transparent bg-transparent text-ink-muted",
                  ].join(" ")}
                >
                  {step.label}
                </div>
              );
            })}
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
            <div className="space-y-5">
              {/* --- Dropzone --- */}
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={`relative overflow-hidden rounded-[26px] border-2 border-dashed p-6 transition-all ${
                  dragging
                    ? "border-accent bg-accent-soft/40 dark:bg-accent/10"
                    : "border-border-light bg-surface-light dark:bg-surface-dark dark:border-border-dark"
                }`}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept="audio/mp3,audio/wav,audio/m4a,audio/aac"
                  onChange={handleInputChange}
                  className="hidden"
                />

                <div className="flex flex-col items-center justify-center gap-4 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft text-accent dark:bg-accent/10">
                    <UploadCloud className="h-7 w-7" />
                  </div>

                  <div>
                    <h3 className="text-lg font-semibold text-ink-light dark:text-ink-dark">
                      Arraste um áudio ou selecione um arquivo
                    </h3>
                    <p className="mt-1 text-sm text-ink-muted">
                      MP3, WAV ou M4A · até 25MB · você revisa a tradução antes de sintetizar
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => inputRef.current?.click()}
                      className="inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover"
                    >
                      <FileAudio className="mr-2 h-4 w-4" />
                      Escolher arquivo
                    </button>
                    {selectedFile && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedFile(null);
                          setPreviewUrl((prev) => {
                            if (prev) URL.revokeObjectURL(prev);
                            return null;
                          });
                          setReferenceVoiceFile(null);
                          reset();
                        }}
                        className="rounded-xl border border-border-light px-4 py-2.5 text-sm text-ink-muted transition hover:bg-surface-light-sunken dark:border-border-dark dark:hover:bg-surface-dark-sunken"
                      >
                        Limpar
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* --- Progresso --- */}
              <div className="rounded-[24px] border border-border-light bg-surface-light dark:border-border-dark dark:bg-surface-dark p-4 md:p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-muted">
                      Progresso
                    </p>
                    <p className="mt-1 text-sm text-ink-light dark:text-ink-dark">
                      {currentMeta.description}
                    </p>
                  </div>
                  <div className="text-sm font-medium text-ink-light dark:text-ink-dark">
                    {currentMeta.progress}%
                  </div>
                </div>

                <div className="h-2 overflow-hidden rounded-full bg-surface-light-sunken dark:bg-surface-dark-sunken">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent to-accent-hover transition-all duration-300"
                    style={{ width: `${currentMeta.progress}%` }}
                  />
                </div>

                <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-border-light bg-surface-light-raised p-3 dark:border-border-dark dark:bg-surface-dark-raised">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent dark:bg-accent/10">
                      {isProcessing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : status === "success" ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <Mic2 className="h-4 w-4" />
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-ink-light dark:text-ink-dark">
                        {selectedFile ? selectedFile.name : "Nenhum arquivo selecionado"}
                      </div>
                      <div className="text-xs text-ink-muted">
                        {selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB` : "Aguardando áudio"}
                      </div>
                    </div>
                  </div>

                  {/* Passo 1: só aparece antes de termos um preview (transcrição+tradução) */}
                  {!preview && (
                    <button
                      type="button"
                      onClick={handleTranscribe}
                      disabled={!selectedFile || isProcessing}
                      className="inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isTranscribing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Languages className="mr-2 h-4 w-4" />
                      )}
                      {transcribeButtonLabel}
                    </button>
                  )}
                </div>

                {error && (
                  <p className="mt-3 rounded-xl border border-red-200 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:text-red-300">
                    {error}
                  </p>
                )}
              </div>

              {/* --- Passo 2: revisão da tradução + voz de referência + sintetizar --- */}
              {preview && (
                <div className="rounded-[24px] border border-violet-300/50 bg-surface-light dark:border-violet-500/30 dark:bg-surface-dark p-4 md:p-5">
                  <div className="mb-4 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-ink-muted">
                      Revisar antes de sintetizar
                    </h3>
                  </div>

                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Transcrição original (idioma de origem)
                    </span>
                    <textarea
                      readOnly
                      value={preview.transcript}
                      rows={3}
                      className="w-full resize-y rounded-xl border border-border-light bg-surface-light-sunken px-3 py-2.5 text-sm text-ink-muted outline-none dark:border-border-dark dark:bg-surface-dark-sunken"
                    />
                  </label>

                  <label className="mt-4 block">
                    <span className="mb-1.5 block text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Tradução — corrija se precisar antes de sintetizar
                    </span>
                    <textarea
                      value={translatedText}
                      onChange={(event) => setTranslatedText(event.target.value)}
                      rows={4}
                      disabled={isSynthesizing}
                      className="w-full resize-y rounded-xl border border-border-light bg-surface-light-raised px-3 py-2.5 text-sm text-ink-light outline-none transition focus:border-accent disabled:opacity-60 dark:border-border-dark dark:bg-surface-dark-raised dark:text-ink-dark"
                    />
                  </label>

                  <label className="mt-4 block">
                    <span className="mb-1.5 block text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Voz de referência (opcional)
                    </span>
                    <input
                      ref={referenceInputRef}
                      type="file"
                      accept="audio/mp3,audio/wav,audio/m4a,audio/aac"
                      onChange={handleReferenceVoiceChange}
                      className="hidden"
                    />
                    <div className="flex items-center gap-2 rounded-xl border border-dashed border-border-light bg-surface-light-raised px-3 py-2.5 dark:border-border-dark dark:bg-surface-dark-raised">
                      <Music2 className="h-4 w-4 shrink-0 text-ink-muted" />
                      <span className="flex-1 truncate text-sm text-ink-muted">
                        {referenceVoiceFile
                          ? referenceVoiceFile.name
                          : "Vazio = clona a voz do áudio original enviado acima"}
                      </span>
                      <button
                        type="button"
                        onClick={() => referenceInputRef.current?.click()}
                        className="shrink-0 rounded-lg border border-border-light px-2.5 py-1 text-xs text-ink-muted transition hover:bg-surface-light-sunken dark:border-border-dark dark:hover:bg-surface-dark-sunken"
                      >
                        Escolher
                      </button>
                      {referenceVoiceFile && (
                        <button
                          type="button"
                          onClick={() => setReferenceVoiceFile(null)}
                          className="shrink-0 rounded-lg p-1 text-ink-muted transition hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken"
                          aria-label="Remover voz de referência"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </label>

                  <button
                    type="button"
                    onClick={handleSynthesize}
                    disabled={isSynthesizing || !translatedText.trim()}
                    className="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSynthesizing ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Wand2 className="mr-2 h-4 w-4" />
                    )}
                    {synthesizeButtonLabel}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-5">
              <div className="rounded-[24px] border border-border-light bg-surface-light dark:border-border-dark dark:bg-surface-dark p-4 md:p-5">
                <div className="mb-4 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-accent" />
                  <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-ink-muted">
                    Idiomas
                  </h3>
                </div>

                <div className="space-y-4">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-ink-muted uppercase tracking-wide">Idioma de origem (do áudio)</span>
                    <select
                      value={settings.sourceLanguage}
                      onChange={(event) =>
                        persistSettings({
                          ...settings,
                          sourceLanguage: event.target.value as AudioTargetLanguage,
                        })
                      }
                      className="w-full rounded-xl border border-border-light bg-surface-light-raised px-3 py-2.5 text-sm text-ink-light outline-none transition focus:border-accent dark:border-border-dark dark:bg-surface-dark-raised dark:text-ink-dark"
                    >
                      {languageOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-ink-muted uppercase tracking-wide">Idioma alvo (da dublagem)</span>
                    <select
                      value={settings.targetLanguage}
                      onChange={(event) =>
                        persistSettings({
                          ...settings,
                          targetLanguage: event.target.value as AudioTargetLanguage,
                        })
                      }
                      className="w-full rounded-xl border border-border-light bg-surface-light-raised px-3 py-2.5 text-sm text-ink-light outline-none transition focus:border-accent dark:border-border-dark dark:bg-surface-dark-raised dark:text-ink-dark"
                    >
                      {languageOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="rounded-[24px] border border-border-light bg-surface-light dark:border-border-dark dark:bg-surface-dark p-4 md:p-5">
                <div className="mb-4 flex items-center gap-2">
                  <Volume2 className="h-4 w-4 text-accent" />
                  <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-ink-muted">
                    Antes vs Depois
                  </h3>
                </div>

                <div className="space-y-4">
                  {previewUrl || comparisonAudio?.originalUrl ? (
                    <>
                      <div className="rounded-2xl border border-border-light bg-surface-light-raised p-3 dark:border-border-dark dark:bg-surface-dark-raised">
                        <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-ink-muted">
                          <span>Original</span>
                          <span>Áudio bruto</span>
                        </div>
                        <AudioBars active={isTranscribing} />
                        <audio controls src={previewUrl || comparisonAudio?.originalUrl || ""} className="mt-3 w-full" />
                      </div>

                      <div className="flex justify-center text-ink-muted">
                        <ArrowRightLeft className="h-4 w-4" />
                      </div>

                      <div className="rounded-2xl border border-accent/30 bg-accent-soft/40 p-3 dark:border-accent/30 dark:bg-accent/5">
                        <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-ink-muted">
                          <span>Dublado</span>
                          <span>Versão final</span>
                        </div>
                        <AudioBars active={isSynthesizing} />
                        <audio controls src={comparisonAudio?.dubbedUrl || ""} className="mt-3 w-full" />
                      </div>
                    </>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border-light bg-surface-light-raised p-6 text-center text-sm text-ink-muted dark:border-border-dark dark:bg-surface-dark-raised">
                      Faça upload de um áudio para comparar as versões original e dublada.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
