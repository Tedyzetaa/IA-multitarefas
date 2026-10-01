export type Role = "user" | "assistant" | "system";

export type AttachmentType = "image" | "pdf" | "zip";

/** Anexo multimodal enviado junto a uma mensagem do usuário. */
export interface ChatAttachment {
  id: string;
  name: string;
  type: AttachmentType;
  mimeType: string;
  size: number;
  /**
   * Conteúdo já pronto para o payload do modelo:
   *  - image: base64 puro (sem prefixo "data:..."), vai no campo `images` do Ollama
   *  - pdf:   texto extraído do documento
   *  - zip:   listagem formatada dos arquivos contidos no pacote
   */
  data: string;
  /** data URL completa (somente imagens) — usada para exibir a miniatura no chat */
  previewUrl?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** true enquanto o texto ainda está sendo transmitido via stream */
  streaming?: boolean;
  /** modelo usado para gerar a resposta (apenas assistant) */
  model?: string;
  /** arquivos anexados pelo usuário a esta mensagem */
  attachments?: ChatAttachment[];
  /** presente quando esta mensagem representa um job de geração de vídeo (nexus-bridge) */
  video?: VideoGeneration;
  /** presente quando esta mensagem representa um job de geração de imagem (nexus-bridge, t2i/i2i) */
  image?: ImageGeneration;
}

/**
 * Espelha app/models.py::JobStatus do nexus-bridge. Genérico o bastante para
 * cobrir tanto o pipeline de vídeo (refining_prompt -> unloading_llm ->
 * generating_video) quanto o de imagem (generating_image) -- ambos usam o
 * mesmo formato de Job no backend (ver NexusJob em lib/nexusBridge.ts),
 * então um único union type evita duplicar os estados em dois lugares.
 */
export type JobStatus =
  | "queued"
  | "refining_prompt"
  | "unloading_llm"
  | "generating_video"
  | "generating_image"
  | "completed"
  | "failed";

/** Alias mantido para não quebrar imports existentes de VideoJobStatus. */
export type VideoJobStatus = JobStatus;

export interface VideoGeneration {
  /** vazio até a resposta de POST /api/generate-video voltar */
  jobId: string;
  status: JobStatus;
  prompt: string;
  /** preenchido quando status === "completed" */
  url?: string;
  /** preenchido quando status === "failed" */
  error?: string;
}

/** Espelha VideoGeneration, para o pipeline t2i/i2i via ComfyUI. */
export interface ImageGeneration {
  /** vazio até a resposta de POST /api/generate voltar */
  jobId: string;
  status: JobStatus;
  prompt: string;
  /** "t2i" (texto -> imagem) ou "i2i" (imagem -> imagem) */
  mode: "t2i" | "i2i";
  /** preenchido quando status === "completed" */
  url?: string;
  /** preenchido quando status === "failed" */
  error?: string;
}

/** Mensagem no formato aceito pelo endpoint /api/chat do Ollama. */
export interface OllamaApiMessage {
  role: Role;
  content: string;
  /** base64 das imagens anexadas (multimodal) */
  images?: string[];
}

export type ConversationMode = "text" | "image" | "video" | "audio";

export type AudioDubbingStatus =
  | "idle"
  | "transcribing"
  | "reviewing"
  | "synthesizing"
  | "success"
  | "error";
export type AudioTargetLanguage =
  | "pt-BR"
  | "en-US"
  | "es-ES"
  | "fr-FR"
  | "de-DE"
  | "ja-JP";
export type AudioVoiceProvider = "openai" | "elevenlabs" | "azure";

export type VoiceGender = "female" | "male" | "neutral";

export interface VoiceProfile {
  id: string;
  name: string;
  locale: AudioTargetLanguage;
  gender: VoiceGender;
  style: string;
  description: string;
}

export type TtsFormat = "mp3" | "wav" | "ogg";
export type TtsEmotion = "neutral" | "happy" | "sad" | "angry" | "calm" | "excited";

export interface TtsOptions {
  text: string;
  voiceId: string;
  language: AudioTargetLanguage;
  speed: number;
  pitch: number;
  format: TtsFormat;
  emotion: TtsEmotion;
  referenceAudioUrl?: string;
}

export interface AudioDubbingSettings {
  /** idioma falado no áudio original (usado pelo Whisper na transcrição) */
  sourceLanguage: AudioTargetLanguage;
  targetLanguage: AudioTargetLanguage;
  /** Campos abaixo (ElevenLabs) não são usados pelo fluxo local
   * translation_dubbing atual -- mantidos só pra não quebrar SettingsModal.tsx. */
  voiceProvider: AudioVoiceProvider;
  voiceId: string;
  stability: number;
  similarityBoost: number;
}

export interface AudioDubbingRequest {
  audioBase64: string;
  fileName: string;
  mimeType: string;
  targetLanguage: AudioTargetLanguage;
  voiceProvider: AudioVoiceProvider;
  stability: number;
  similarityBoost: number;
}

/** Resposta de POST /api/v1/dubbing/preview: transcrição + tradução para o
 * usuário revisar/corrigir antes de confirmar a síntese (ver synthesizeAudioDubbing). */
export interface AudioDubbingPreviewResult {
  sessionId: string;
  transcript: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface AudioDubbingResult {
  status: AudioDubbingStatus;
  progress: number;
  originalUrl?: string;
  dubbedUrl?: string;
  fileName?: string;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Modo da conversa: travado após a primeira mensagem */
  mode?: ConversationMode;
}

export interface OllamaModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

/** Um artefato detectado dentro de uma mensagem (bloco de código "grande") */
export interface Artifact {
  id: string;
  language: string;
  code: string;
  title: string;
  messageId: string;
}

/** Formato de cada linha NDJSON retornada por /api/chat do Ollama */
export interface OllamaChatStreamChunk {
  model: string;
  created_at: string;
  message?: { role: Role; content: string };
  done: boolean;
  done_reason?: string;
}
