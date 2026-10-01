import {
  VideoGeneration,
  ImageGeneration,
  JobStatus,
  AudioDubbingPreviewResult,
  AudioDubbingRequest,
  AudioDubbingResult,
  AudioDubbingSettings,
  TtsOptions,
  VoiceProfile,
} from "./types";
import { VideoGenSettings } from "./settings";

// Mesmo raciocínio do useOllamaStream: sempre passar pelo rewrite do
// Next.js (configurado em next.config.js como "/nexus-proxy" ->
// NEXUS_INTERNAL_URL, default http://127.0.0.1:8000). Isso mantém a
// chamada same-origin do ponto de vista do navegador, então o
// CORS_ORIGINS do nexus-bridge (pensado para um frontend Vite em :5173)
// nunca entra em jogo aqui.
const NEXUS_BASE_URL = process.env.NEXT_PUBLIC_NEXUS_URL || "/nexus-proxy";

const POLL_INTERVAL_MS = 2000;

const toCamelCase = (key: string): string =>
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export function mapSnakeToCamelCase<T extends Record<string, unknown>>(payload: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [toCamelCase(key), value])
  );
}

/** Formato de app/models.py::Job no nexus-bridge (só os campos que usamos aqui). */
export interface NexusJob {
  id: string;
  status: JobStatus;
  file_path?: string | null;
  error?: string | null;
}

/** Imagem de referência (produto) para o pipeline img2video do LTX-Video. */
export interface VideoSourceImage {
  /** base64 puro, sem prefixo "data:..." (mesmo formato usado no ChatAttachment) */
  base64: string;
  mimeType: string;
}

export interface StartVideoJobOptions {
  prompt: string;
  /** opcional: quando presente, o nexus-bridge roda o fluxo img2video
   * (LoadImage -> ImageScaleToMaxDimension -> LTXVImgToVideo, ver
   * _workflow.json) em vez de text2video puro. */
  image?: VideoSourceImage;
  settings: VideoGenSettings;
}

/** Imagem de referência para o modo i2i (ver app/providers/comfyui_provider.py). */
export interface ImageSourceImage {
  /** base64 puro OU data URI completa ("data:image/jpeg;base64,...") --
   * o backend aceita os dois formatos (ver ComfyUIImageProvider._decode_base64_image). */
  base64: string;
  mimeType: string;
}

export type ImageGenMode = "t2i" | "i2i";

export interface StartImageJobOptions {
  prompt: string;
  mode: ImageGenMode;
  /** obrigatório quando mode === "i2i"; ignorado em "t2i". */
  image?: ImageSourceImage;
  negativePrompt?: string;
  seed?: number;
}

/**
 * Dispara POST /api/generate-video e devolve o Job já criado (status
 * inicial "queued"). Lança erro se o nexus-bridge não responder 2xx --
 * quem chama decide como exibir isso (ver page.tsx).
 *
 * O payload espelha os campos do _workflow.json (nó "16" / LTXVImgToVideo
 * e "6" / KSampler): width, height, length, denoise. `image_base64` e
 * `image_mime_type` só vão quando o usuário anexou uma imagem de produto;
 * nesse caso é o backend quem decide se popula o nó "9" (LoadImage) do
 * workflow ou cai para geração pura por texto.
 */
export async function startVideoJob({
  prompt,
  image,
  settings,
}: StartVideoJobOptions): Promise<NexusJob> {
  const res = await fetch(`${NEXUS_BASE_URL}/api/generate-video`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_prompt: prompt,
      input_image_base64: image?.base64,
      image_mime_type: image?.mimeType,
      width: settings.width,
      height: settings.height,
      length: settings.length,
      denoise: settings.denoise,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `nexus-bridge respondeu ${res.status} em /api/generate-video: ${detail.slice(0, 300)}`
    );
  }

  return res.json();
}

/**
 * Dispara POST /api/generate no modo t2i ou i2i e devolve o Job já criado
 * (status inicial "queued"). Mesmo padrão assíncrono de startVideoJob: a
 * chamada só enfileira o job, quem acompanha o progresso é pollVideoJob
 * (renomeado abaixo para pollJob, já que agora serve os dois pipelines) --
 * isso é o que evita a conexão HTTP ficar presa por minutos aguardando o
 * ComfyUI terminar, seja em T2I/I2I ou no T2V já existente.
 *
 * Bug evitado aqui: `image?.base64` é repassado como veio do FileReader
 * (pode ou não ter o prefixo "data:image/...;base64,") -- a limpeza fica
 * inteiramente no backend (ComfyUIImageProvider._decode_base64_image), para
 * não duplicar essa lógica em dois lugares.
 */
export async function startImageJob({
  prompt,
  mode,
  image,
  negativePrompt,
  seed,
}: StartImageJobOptions): Promise<NexusJob> {
  if (mode === "i2i" && !image?.base64) {
    // Falha cedo no cliente com uma mensagem legível, em vez de deixar o
    // nexus-bridge devolver um 422 genérico do Pydantic.
    throw new Error("O modo image-to-image requer uma imagem anexada.");
  }

  const res = await fetch(`${NEXUS_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_prompt: prompt,
      mode,
      image_base64: image?.base64,
      negative_prompt: negativePrompt ?? "",
      seed,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `nexus-bridge respondeu ${res.status} em /api/generate: ${detail.slice(0, 300)}`
    );
  }

  return res.json();
}

/**
 * Faz polling de GET /api/jobs/{id} a cada POLL_INTERVAL_MS até o job
 * chegar em "completed" ou "failed". Chama `onUpdate` a cada resposta
 * (para refletir os estágios intermediários: refining_prompt ->
 * unloading_llm -> generating_video) e `onSettled` uma única vez ao final.
 *
 * Retorna uma função de cancelamento (ex: se o usuário trocar de conversa
 * no meio do polling e você não quiser mais atualizar aquela mensagem).
 */
export function pollVideoJob(
  jobId: string,
  onUpdate: (job: NexusJob) => void,
  onSettled: (job: NexusJob) => void
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) return;

    let job: NexusJob;
    try {
      const res = await fetch(`${NEXUS_BASE_URL}/api/jobs/${jobId}`);
      if (!res.ok) {
        throw new Error(`Job não encontrado (status ${res.status}).`);
      }
      job = await res.json();
    } catch (err) {
      if (!cancelled) {
        onSettled({ id: jobId, status: "failed", error: (err as Error).message });
      }
      return;
    }

    if (cancelled) return;
    onUpdate(job);

    if (job.status === "completed" || job.status === "failed") {
      onSettled(job);
      return;
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS);
  };

  tick();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * O nexus-bridge devolve `file_path` como caminho de arquivo no disco do
 * servidor (ex: "C:\...\generated_videos\<uuid>.mp4"), não uma URL -- o
 * vídeo é servido separadamente em StaticFiles montado em "/videos". Aqui
 * extraímos só o nome do arquivo e montamos a URL final.
 */
export function videoUrlFromFilePath(filePath: string): string {
  const filename = filePath.split(/[\\/]/).pop();
  return `${NEXUS_BASE_URL}/videos/${filename}`;
}

/** Mesma lógica de videoUrlFromFilePath, para os arquivos servidos em
 * StaticFiles("/images") (ver app/main.py -- settings.OUTPUT_DIR). */
export function imageUrlFromFilePath(filePath: string): string {
  const filename = filePath.split(/[\\/]/).pop();
  return `${NEXUS_BASE_URL}/images/${filename}`;
}

export function buildInitialVideoGeneration(prompt: string): VideoGeneration {
  return { jobId: "", status: "queued", prompt };
}

/** Espelha buildInitialVideoGeneration, para o pipeline t2i/i2i. */
export function buildInitialImageGeneration(
  prompt: string,
  mode: ImageGenMode
): ImageGeneration {
  return { jobId: "", status: "queued", prompt, mode };
}

/**
 * Alias genérico de pollVideoJob: o polling em si (GET /api/jobs/{id} até
 * completed/failed) não tem nada específico de vídeo -- serve igualmente
 * para acompanhar jobs de imagem (t2i/i2i) criados por startImageJob.
 * Mantido como alias (em vez de renomear pollVideoJob) para não quebrar
 * quem já importa pollVideoJob em app/page.tsx.
 */
export const pollJob = pollVideoJob;

/** Mesma lógica de imageUrlFromFilePath, para os arquivos servidos em
 * StaticFiles("/audio") (ver app/main.py -- settings.OUTPUT_DIR_AUDIO). */
export function audioUrlFromFilePath(filePath: string): string {
  const filename = filePath.split(/[\\/]/).pop();
  return `${NEXUS_BASE_URL}/audio/${filename}`;
}

/**
 * Transforma a resposta de erro do nexus-bridge em texto legível. O backend
 * devolve JSON ({ detail: string | [{loc,msg}], hint? }); o proxy do Next
 * devolve texto puro ("Internal Server Error") quando ele mesmo falha.
 */
async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as {
      detail?: string | { loc?: (string | number)[]; msg?: string }[];
      error?: string;
      hint?: string | null;
    };
    let msg: string;
    if (typeof json.detail === "string") {
      msg = json.detail;
    } else if (Array.isArray(json.detail)) {
      msg = json.detail
        .map((e) => `${(e.loc ?? []).filter((p) => p !== "body").join(".")}: ${e.msg}`)
        .join("; ");
    } else {
      msg = json.error ?? text;
    }
    return (json.hint ? `${msg} — ${json.hint}` : msg).slice(0, 500);
  } catch {
    return text.slice(0, 300);
  }
}

/** Espera um job terminar (promessa em cima do pollJob). */
function waitForJob(jobId: string): Promise<NexusJob> {
  return new Promise((resolve) => {
    pollVideoJob(jobId, () => {}, resolve);
  });
}

/** Resposta de POST /api/v1/dubbing/process (app/models.py::DubbingResponse). */
interface DubbingApiResponse {
  job_id: string;
  audio_url?: string | null;
  file_path?: string | null;
  message?: string;
}

/**
 * Envia o áudio para o nexus-bridge (Speech-to-Speech / ElevenLabs).
 *
 * - Arquivos < DUBBING_BACKGROUND_THRESHOLD_BYTES (10MB) voltam prontos (`audio_url`).
 * - Arquivos maiores voltam só com `job_id`: acompanhamos o job até terminar.
 *
 * Só anexamos campos com valor: `formData.append("x", undefined)` vira a string
 * "undefined" e o FastAPI responde 422 (ex.: "stability: unable to parse string as a number").
 * NÃO definir Content-Type manualmente -- o navegador precisa gerar o boundary.
 */
export async function processAudioDubbing(
  file: File,
  settings: AudioDubbingSettings
): Promise<AudioDubbingResult> {
  const formData = new FormData();
  formData.append("file", file, file.name); // o nome do campo TEM que ser "file"

  const fields: Record<string, string | undefined> = {
    voice_id: settings.voiceId?.trim() || undefined,
    provider: "elevenlabs", // único provider implementado no backend
    target_language: settings.targetLanguage,
    stability: Number.isFinite(settings.stability) ? String(settings.stability) : undefined,
    similarity_boost: Number.isFinite(settings.similarityBoost)
      ? String(settings.similarityBoost)
      : undefined,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value) formData.append(key, value);
  }

  const res = await fetch(`${NEXUS_BASE_URL}/api/v1/dubbing/process`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(
      `nexus-bridge respondeu ${res.status} em /api/v1/dubbing/process: ${await readErrorMessage(res)}`
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  const data = mapSnakeToCamelCase(json) as Record<string, unknown>;

  // Caminho síncrono: o áudio já está pronto.
  if (typeof data.audioUrl === "string" && data.audioUrl) {
    return {
      status: "success",
      progress: 100,
      dubbedUrl: `${NEXUS_BASE_URL}${data.audioUrl}`,
      fileName: data.audioUrl.split("/").pop(),
    };
  }

  // Caminho em background (arquivo grande): acompanha o job até concluir.
  const job = await waitForJob(String((data.jobId as string | undefined) ?? ""));
  if (job.status === "failed" || !job.file_path) {
    return {
      status: "error",
      progress: 0,
      error: job.error ?? "A dublagem terminou sem gerar o arquivo de áudio.",
    };
  }
  return {
    status: "success",
    progress: 100,
    dubbedUrl: audioUrlFromFilePath(job.file_path),
    fileName: job.file_path.split(/[\\/]/).pop(),
  };
}

/** Resposta de POST /api/v1/dubbing/preview (app/models.py::DubbingPreviewResponse). */
interface DubbingPreviewApiResponse {
  session_id: string;
  transcript: string;
  translated_text: string;
  source_language: string;
  target_language: string;
  expires_in_seconds: number;
}

/**
 * Passo 1 do fluxo revisável: envia o áudio original, o nexus-bridge
 * transcreve (Whisper, processo isolado) e traduz (Ollama), mas NÃO
 * sintetiza ainda. Devolve translatedText para o usuário corrigir antes de
 * confirmar em synthesizeAudioDubbing.
 *
 * sourceLanguage vem como "en-US" etc. (AudioTargetLanguage) mas o Whisper
 * só entende o código curto -- cortamos o sufixo de região aqui.
 */
export async function previewAudioDubbing(
  file: File,
  sourceLanguage: string,
  targetLanguage: string
): Promise<AudioDubbingPreviewResult> {
  const formData = new FormData();
  formData.append("file", file, file.name); // o nome do campo TEM que ser "file"
  formData.append("source_language", sourceLanguage.split("-")[0]);
  formData.append("target_language", targetLanguage);

  const res = await fetch(`${NEXUS_BASE_URL}/api/v1/dubbing/preview`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(
      `nexus-bridge respondeu ${res.status} em /api/v1/dubbing/preview: ${await readErrorMessage(res)}`
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  const data = mapSnakeToCamelCase(json) as Record<string, unknown>;

  return {
    sessionId: String(data.sessionId ?? ""),
    transcript: String(data.transcript ?? ""),
    translatedText: String(data.translatedText ?? ""),
    sourceLanguage: String(data.sourceLanguage ?? ""),
    targetLanguage: String(data.targetLanguage ?? ""),
  };
}

/**
 * Passo 2 do fluxo revisável: sintetiza `translatedText` (já revisado/corrigido
 * pelo usuário) com XTTS v2, usando o `sessionId` devolvido por previewAudioDubbing.
 *
 * `referenceVoice` é OPCIONAL: se enviado, o XTTS clona essa voz; se omitido,
 * o backend clona a voz do próprio áudio original enviado no passo 1.
 */
export async function synthesizeAudioDubbing(
  sessionId: string,
  translatedText: string,
  targetLanguage: string,
  referenceVoice?: File | null
): Promise<AudioDubbingResult> {
  const formData = new FormData();
  formData.append("session_id", sessionId);
  formData.append("translated_text", translatedText);
  formData.append("target_language", targetLanguage);
  if (referenceVoice) {
    formData.append("reference_voice", referenceVoice, referenceVoice.name);
  }

  const res = await fetch(`${NEXUS_BASE_URL}/api/v1/dubbing/synthesize`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(
      `nexus-bridge respondeu ${res.status} em /api/v1/dubbing/synthesize: ${await readErrorMessage(res)}`
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  const data = mapSnakeToCamelCase(json) as Record<string, unknown>;
  const audioUrl = typeof data.audioUrl === "string" ? data.audioUrl : undefined;

  if (!audioUrl) {
    return { status: "error", progress: 0, error: "O nexus-bridge não devolveu audio_url na síntese." };
  }
  return {
    status: "success",
    progress: 100,
    dubbedUrl: `${NEXUS_BASE_URL}${audioUrl}`,
    fileName: audioUrl.split("/").pop(),
  };
}

export async function listVoiceProfiles(): Promise<VoiceProfile[]> {
  const res = await fetch(`${NEXUS_BASE_URL}/api/v1/voices`);
  if (!res.ok) {
    throw new Error(`nexus-bridge respondeu ${res.status} em /api/v1/voices`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const data = Array.isArray(json.items)
    ? json.items
    : Array.isArray(json.voices)
      ? json.voices
      : [];

  return (data as Record<string, unknown>[]).map((voice) => {
    const mapped = mapSnakeToCamelCase(voice) as Record<string, unknown>;
    return {
      id: String(mapped.id ?? ""),
      name: String(mapped.name ?? "voice"),
      locale: (String(mapped.locale ?? "pt-BR") as VoiceProfile["locale"]),
      gender: (String(mapped.gender ?? "neutral") as VoiceProfile["gender"]),
      style: String(mapped.style ?? "natural"),
      description: String(mapped.description ?? "Perfil de voz"),
    } satisfies VoiceProfile;
  });
}

export async function generateTextToSpeech(options: TtsOptions): Promise<{ audioUrl: string }> {
  const formData = new FormData();
  formData.append("text", options.text);
  formData.append("voice_id", options.voiceId);
  formData.append("language", options.language);
  formData.append("speed", String(options.speed));
  formData.append("pitch", String(options.pitch));
  formData.append("format", options.format);
  formData.append("emotion", options.emotion);
  if (options.referenceAudioUrl) {
    formData.append("reference_audio_url", options.referenceAudioUrl);
  }

  const res = await fetch(`${NEXUS_BASE_URL}/api/v1/tts/generate`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(
      `nexus-bridge respondeu ${res.status} em /api/v1/tts/generate: ${await readErrorMessage(res)}`
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  const data = mapSnakeToCamelCase(json) as Record<string, unknown>;
  const audioUrl = String(data.audioUrl ?? data.audio_url ?? "");

  return { audioUrl: audioUrl ? `${NEXUS_BASE_URL}${audioUrl}` : audioUrl };
}
