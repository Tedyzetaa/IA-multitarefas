/**
 * Parâmetros de geração de vídeo enviados ao nexus-bridge -> ComfyUI
 * (nó LTXVImgToVideo, ver _workflow.json). Espelham exatamente os campos
 * que o workflow local usa: width/height do LTXVImgToVideo, length
 * (frames) e denoise/strength do KSampler.
 */
export interface VideoGenSettings {
  width: number;
  height: number;
  /** número de frames (nó LTXVImgToVideo -> "length") */
  length: number;
  /** denoise do KSampler (0.7 = mantém boa parte da imagem original) */
  denoise: number;
}

/**
 * Valores validados no workflow local (RTX 3050 6GB Laptop, 16GB RAM):
 * 512x320 @ 33 frames, denoise 0.70 — é o teto seguro contra OOM nessa
 * VRAM. Resoluções maiores (ex: 512x512) ou mais frames aumentam o uso
 * de VRAM do VAE/latents rapidamente e já causaram crash nesse setup.
 */
export const SAFE_VIDEO_SETTINGS: VideoGenSettings = {
  width: 512,
  height: 320,
  length: 33,
  denoise: 0.7,
};

/** Teto absoluto permitido mesmo com "modo seguro" desligado — nunca
 * deixamos o app mandar um job garantido de estourar 6GB de VRAM. */
export const MAX_VIDEO_SETTINGS: VideoGenSettings = {
  width: 768,
  height: 512,
  length: 65,
  denoise: 1.0,
};

export function clampVideoSettings(s: VideoGenSettings): VideoGenSettings {
  return {
    width: Math.min(Math.max(64, s.width), MAX_VIDEO_SETTINGS.width),
    height: Math.min(Math.max(64, s.height), MAX_VIDEO_SETTINGS.height),
    length: Math.min(Math.max(9, s.length), MAX_VIDEO_SETTINGS.length),
    denoise: Math.min(Math.max(0.1, s.denoise), MAX_VIDEO_SETTINGS.denoise),
  };
}

import { AudioDubbingSettings } from "./types";

export interface AppSettings {
  systemPrompt: string;
  temperature: number;
  ollamaUrl: string;
  /** true = usa sempre SAFE_VIDEO_SETTINGS, ignorando `video` abaixo (protege VRAM 6GB) */
  videoSafeMode: boolean;
  /** só tem efeito quando videoSafeMode === false */
  video: VideoGenSettings;
  audioDubbing: AudioDubbingSettings;
}

const SETTINGS_KEY = "ollama-chat-settings";

export const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt: "",
  temperature: 0.7,
  ollamaUrl: "",
  videoSafeMode: true,
  video: SAFE_VIDEO_SETTINGS,
  audioDubbing: {
    sourceLanguage: "en-US", // áudio original tipicamente em inglês
    targetLanguage: "pt-BR",
    voiceProvider: "elevenlabs", // único provider implementado no nexus-bridge
    voiceId: "",
    stability: 0.72,
    similarityBoost: 0.88,
  },
};

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      video: { ...DEFAULT_SETTINGS.video, ...parsed.video },
      audioDubbing: {
        ...DEFAULT_SETTINGS.audioDubbing,
        ...parsed.audioDubbing,
        // configs antigas salvas no localStorage podem ter "openai"/"azure", que o backend rejeita
        voiceProvider: "elevenlabs",
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

/** Resolve os parâmetros efetivos a usar num job: modo seguro trava nos
 * valores validados; modo avançado usa os do usuário, sempre clampados. */
export function resolveVideoSettings(settings: AppSettings): VideoGenSettings {
  return settings.videoSafeMode
    ? SAFE_VIDEO_SETTINGS
    : clampVideoSettings(settings.video);
}
