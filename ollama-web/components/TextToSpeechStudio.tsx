"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  Loader2,
  Mic,
  Music4,
  Play,
  Sparkles,
  Volume2,
  Waves,
} from "lucide-react";
import { TtsOptions, VoiceProfile } from "@/lib/types";

const VOICE_PROFILES: VoiceProfile[] = [
  {
    id: "nova-pt-br",
    name: "Nova",
    locale: "pt-BR",
    gender: "female",
    style: "clara e confiante",
    description: "Tom natural para vídeos e explicações curtas.",
  },
  {
    id: "orion-en-us",
    name: "Orion",
    locale: "en-US",
    gender: "male",
    style: "cinemático",
    description: "Voz clara e profunda para narrativas premium.",
  },
  {
    id: "sol-es-es",
    name: "Sol",
    locale: "es-ES",
    gender: "female",
    style: "amigável",
    description: "Acento espanhol com tom acolhedor.",
  },
];

const DEFAULT_TTS_OPTIONS: TtsOptions = {
  text: "Olá, este é um exemplo de geração de voz em português brasileiro.",
  voiceId: "nova-pt-br",
  language: "pt-BR",
  speed: 1,
  pitch: 1,
  format: "mp3",
  emotion: "neutral",
};

function mergeFloat32Arrays(chunks: Float32Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  floatTo16BitPCM(view, 44, samples);

  return new Blob([view], { type: "audio/wav" });
}

export default function TextToSpeechStudio() {
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioChunksRef = useRef<Float32Array[]>([]);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);

  const [voiceId, setVoiceId] = useState<string>(DEFAULT_TTS_OPTIONS.voiceId ?? "nova-pt-br");
  const [language, setLanguage] = useState<TtsOptions["language"]>(DEFAULT_TTS_OPTIONS.language);
  const [text, setText] = useState<string>(DEFAULT_TTS_OPTIONS.text ?? "");
  const [speed, setSpeed] = useState<number>(DEFAULT_TTS_OPTIONS.speed ?? 1);
  const [pitch, setPitch] = useState<number>(DEFAULT_TTS_OPTIONS.pitch ?? 1);
  const [emotion, setEmotion] = useState<TtsOptions["emotion"]>(DEFAULT_TTS_OPTIONS.emotion ?? "neutral");
  const [referenceAudioUrl, setReferenceAudioUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedAudioUrl, setGeneratedAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (referenceAudioUrl) URL.revokeObjectURL(referenceAudioUrl);
      if (generatedAudioUrl) URL.revokeObjectURL(generatedAudioUrl);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void audioContextRef.current?.close();
    };
  }, [generatedAudioUrl, referenceAudioUrl]);

  const activeVoice =
    VOICE_PROFILES.find((profile) => profile.id === voiceId) ?? VOICE_PROFILES[0];

  const handleReferenceAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    if (referenceAudioUrl) URL.revokeObjectURL(referenceAudioUrl);

    const url = URL.createObjectURL(file);
    setReferenceAudioUrl(url);
  };

  const stopRecording = async () => {
    if (!audioContextRef.current || !streamRef.current || !workletRef.current) {
      setRecording(false);
      return;
    }

    workletRef.current.disconnect();
    streamRef.current.getTracks().forEach((track) => track.stop());

    const sampleRate = audioContextRef.current.sampleRate;
    const merged = mergeFloat32Arrays(audioChunksRef.current);
    const wavBlob = encodeWav(merged, sampleRate);

    const url = URL.createObjectURL(wavBlob);
    if (referenceAudioUrl) URL.revokeObjectURL(referenceAudioUrl);
    setReferenceAudioUrl(url);

    await audioContextRef.current.close();
    audioContextRef.current = null;
    workletRef.current = null;
    streamRef.current = null;
    audioChunksRef.current = [];
    setRecording(false);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextCtor) {
        return;
      }

      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const workletCode = `
        class VoiceReferenceProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (!input || !input.length) {
              return true;
            }
            const channel = input[0];
            this.port.postMessage({ type: 'buffer', buffer: channel.slice(), sampleRate: sampleRate });
            return true;
          }
        }
        registerProcessor('voice-reference-processor', VoiceReferenceProcessor);
      `;

      const workletUrl = URL.createObjectURL(
        new Blob([workletCode], { type: "application/javascript" })
      );

      await context.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(context, "voice-reference-processor");
      audioChunksRef.current = [];

      worklet.port.onmessage = (event: MessageEvent<{ type?: string; buffer?: Float32Array }>) => {
        if (event.data?.buffer) {
          audioChunksRef.current.push(event.data.buffer);
        }
      };

      source.connect(worklet);
      workletRef.current = worklet;
      streamRef.current = stream;
      audioContextRef.current = context;
      setRecording(true);
    } catch (error) {
      console.error("Não foi possível acessar o microfone.", error);
    }
  };

  const handleGenerate = async () => {
    if (!text.trim()) return;

    setIsGenerating(true);
    setGeneratedAudioUrl(null);

    const nextOptions: TtsOptions = {
      text,
      voiceId,
      language,
      speed,
      pitch,
      emotion,
      referenceAudioUrl: referenceAudioUrl ?? undefined,
      format: "mp3",
    };

    console.info("TTS request payload", nextOptions);

    await new Promise((resolve) => window.setTimeout(resolve, 500));

    setIsGenerating(false);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="space-y-5">
        <div className="rounded-[24px] border border-border-light bg-surface-light p-4 dark:border-border-dark dark:bg-surface-dark md:p-5">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-ink-muted">
              Texto → voz
            </h3>
          </div>

          <label className="block">
            <span className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-ink-muted">
              Texto
            </span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
              className="w-full resize-y rounded-2xl border border-border-light bg-surface-light-raised px-3 py-3 text-sm text-ink-light outline-none transition focus:border-accent dark:border-border-dark dark:bg-surface-dark-raised dark:text-ink-dark"
              placeholder="Escreva o roteiro para a voz ..."
            />
          </label>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-ink-muted">
                Perfil de voz
              </span>
              <select
                value={voiceId}
                onChange={(event) => setVoiceId(event.target.value)}
                className="w-full rounded-xl border border-border-light bg-surface-light-raised px-3 py-2.5 text-sm text-ink-light outline-none transition focus:border-accent dark:border-border-dark dark:bg-surface-dark-raised dark:text-ink-dark"
              >
                {VOICE_PROFILES.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.locale}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-ink-muted">
                Idioma
              </span>
              <select
                value={language}
                onChange={(event) => setLanguage(event.target.value as TtsOptions["language"])}
                className="w-full rounded-xl border border-border-light bg-surface-light-raised px-3 py-2.5 text-sm text-ink-light outline-none transition focus:border-accent dark:border-border-dark dark:bg-surface-dark-raised dark:text-ink-dark"
              >
                <option value="pt-BR">Português (Brasil)</option>
                <option value="en-US">Inglês</option>
                <option value="es-ES">Espanhol</option>
              </select>
            </label>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-ink-muted">
                Velocidade
              </span>
              <input
                type="range"
                min={0.7}
                max={1.5}
                step={0.05}
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
                className="w-full accent-accent"
              />
              <span className="mt-1 block text-xs text-ink-muted">{speed.toFixed(2)}x</span>
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-ink-muted">
                Tom
              </span>
              <input
                type="range"
                min={0.8}
                max={1.3}
                step={0.05}
                value={pitch}
                onChange={(event) => setPitch(Number(event.target.value))}
                className="w-full accent-accent"
              />
              <span className="mt-1 block text-xs text-ink-muted">{pitch.toFixed(2)}x</span>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isGenerating || !text.trim()}
              className="inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isGenerating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Gerar voz
            </button>

            <button
              type="button"
              onClick={() => (recording ? void stopRecording() : void startRecording())}
              className="inline-flex items-center justify-center rounded-xl border border-border-light bg-surface-light-raised px-4 py-2.5 text-sm font-medium text-ink-light transition hover:bg-surface-light-sunken dark:border-border-dark dark:bg-surface-dark-raised dark:text-ink-dark dark:hover:bg-surface-dark-sunken"
            >
              {recording ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mic className="mr-2 h-4 w-4" />}
              {recording ? "Parar gravação" : "Gravar voz de referência"}
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-5">
        <div className="rounded-[24px] border border-border-light bg-surface-light p-4 dark:border-border-dark dark:bg-surface-dark md:p-5">
          <div className="mb-4 flex items-center gap-2">
            <AudioLines className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-ink-muted">
              Perfil selecionado
            </h3>
          </div>

          <div className="rounded-2xl border border-border-light bg-surface-light-raised p-4 dark:border-border-dark dark:bg-surface-dark-raised">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-ink-light dark:text-ink-dark">{activeVoice.name}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.16em] text-accent">{activeVoice.locale}</p>
              </div>
              <span className="rounded-full border border-accent/30 bg-accent-soft px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-accent dark:bg-accent/10">
                {activeVoice.gender}
              </span>
            </div>

            <p className="mt-3 text-sm text-ink-muted">{activeVoice.description}</p>
            <p className="mt-2 text-sm text-ink-light dark:text-ink-dark">Estilo: {activeVoice.style}</p>
          </div>

          <div className="mt-4 rounded-2xl border border-dashed border-border-light bg-surface-light-raised p-3 dark:border-border-dark dark:bg-surface-dark-raised">
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <Music4 className="h-4 w-4 text-accent" />
              <span className="flex-1 truncate">
                {referenceAudioUrl ? "Áudio de referência gravado" : "Nenhum áudio de referência"}
              </span>
              <button
                type="button"
                onClick={() => referenceInputRef.current?.click()}
                className="rounded-lg border border-border-light px-2.5 py-1.5 text-xs font-medium text-ink-muted transition hover:bg-surface-light-sunken dark:border-border-dark dark:hover:bg-surface-dark-sunken"
              >
                {referenceAudioUrl ? "Trocar" : "Adicionar"}
              </button>
            </div>

            <input
              ref={referenceInputRef}
              type="file"
              accept="audio/*"
              onChange={handleReferenceAudio}
              className="hidden"
            />

            {referenceAudioUrl && (
              <audio controls src={referenceAudioUrl} className="mt-3 w-full" />
            )}
          </div>
        </div>

        <div className="rounded-[24px] border border-border-light bg-surface-light p-4 dark:border-border-dark dark:bg-surface-dark md:p-5">
          <div className="mb-3 flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-ink-muted">
              Preview
            </h3>
          </div>

          <div className="rounded-2xl border border-border-light bg-surface-light-raised p-3 dark:border-border-dark dark:bg-surface-dark-raised">
            {generatedAudioUrl ? (
              <>
                <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-ink-muted">
                  <Waves className="h-3.5 w-3.5" />
                  Resultado de áudio
                </div>
                <audio controls src={generatedAudioUrl} className="w-full" />
              </>
            ) : (
              <div className="flex min-h-[110px] flex-col items-center justify-center rounded-xl border border-dashed border-border-light bg-surface-light-sunken px-4 py-5 text-center text-sm text-ink-muted dark:border-border-dark dark:bg-surface-dark-sunken">
                <Check className="mb-2 h-5 w-5 text-accent" />
                A preview da locução aparecerá aqui quando a geração terminar.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
