import { AttachmentType, ChatAttachment, ChatMessage, OllamaApiMessage } from "./types";

/** Tamanho máximo por arquivo (15 MB) — evita travar o navegador/base64 gigante. */
export const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;

/** Extensões aceitas pelo input de anexo. */
export const ACCEPTED_FILE_EXTENSIONS = ".pdf,.jpg,.jpeg,.png,.zip";

/** Limite de caracteres extraídos de um PDF, para não estourar o contexto do modelo. */
const MAX_PDF_CHARS = 12000;

/** Limite de entradas listadas de um ZIP. */
const MAX_ZIP_ENTRIES_LISTED = 200;

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Detecta o tipo de anexo a partir do MIME type e/ou extensão do arquivo. */
export function detectAttachmentType(file: File): AttachmentType | null {
  const ext = extOf(file.name);

  if (file.type.startsWith("image/") || ["jpg", "jpeg", "png"].includes(ext)) {
    return "image";
  }
  if (file.type === "application/pdf" || ext === "pdf") {
    return "pdf";
  }
  if (
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed" ||
    ext === "zip"
  ) {
    return "zip";
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Imagem -> preview em data URL + base64 puro para o payload multimodal do Ollama. */
async function buildImageAttachment(file: File): Promise<ChatAttachment> {
  const dataUrl = await readFileAsDataURL(file);
  const base64 = dataUrl.split(",")[1] ?? "";

  return {
    id: makeId(),
    name: file.name,
    type: "image",
    mimeType: file.type || "image/png",
    size: file.size,
    data: base64,
    previewUrl: dataUrl,
  };
}

/** PDF -> extração de texto via pdfjs-dist (carregado dinamicamente, só no cliente). */
async function buildPdfAttachment(file: File): Promise<ChatAttachment> {
  const pdfjsLib = await import("pdfjs-dist");
  // Worker servido via CDN, sempre na mesma versão do pacote instalado —
  // evita ter que copiar o worker.js manualmente para /public.
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  let text = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? (item as { str: string }).str : ""))
      .join(" ");
    text += pageText + "\n\n";
    if (text.length > MAX_PDF_CHARS) break;
  }

  let extracted = text.trim();
  if (!extracted) {
    extracted =
      "[Não foi possível extrair texto deste PDF — provavelmente é um documento escaneado/baseado em imagem.]";
  } else if (extracted.length > MAX_PDF_CHARS) {
    extracted = `${extracted.slice(0, MAX_PDF_CHARS)}\n[...conteúdo truncado por limite de tamanho...]`;
  }

  return {
    id: makeId(),
    name: file.name,
    type: "pdf",
    mimeType: "application/pdf",
    size: file.size,
    data: extracted,
  };
}

/** ZIP -> listagem de metadados (nome/tamanho de cada entrada), via jszip. */
async function buildZipAttachment(file: File): Promise<ChatAttachment> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(file);

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const listing = entries
    .slice(0, MAX_ZIP_ENTRIES_LISTED)
    .map((entry) => `- ${entry.name}`)
    .join("\n");
  const remaining = entries.length - MAX_ZIP_ENTRIES_LISTED;
  const extra = remaining > 0 ? `\n... e mais ${remaining} arquivo(s)` : "";

  const summary = `Arquivo ZIP contendo ${entries.length} arquivo(s):\n${listing}${extra}`;

  return {
    id: makeId(),
    name: file.name,
    type: "zip",
    mimeType: "application/zip",
    size: file.size,
    data: summary,
  };
}

/**
 * Lê um File do input e o converte em um ChatAttachment pronto para uso,
 * despachando para o parser correto conforme o tipo detectado.
 */
export async function buildAttachmentFromFile(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`Arquivo muito grande (máx. ${formatBytes(MAX_ATTACHMENT_SIZE)})`);
  }

  const type = detectAttachmentType(file);
  if (type === "image") return buildImageAttachment(file);
  if (type === "pdf") return buildPdfAttachment(file);
  if (type === "zip") return buildZipAttachment(file);

  throw new Error(`Tipo de arquivo não suportado: ${file.name}`);
}

/**
 * Converte o histórico de ChatMessage (formato de exibição) no formato
 * esperado pelo /api/chat do Ollama:
 *  - anexos de imagem viram base64 no campo `images` da mensagem
 *  - anexos de PDF/ZIP têm seu conteúdo textual injetado no `content`,
 *    entre marcadores, para que o modelo "leia" o arquivo como contexto
 * O `content` exibido na UI (ChatMessage.content) nunca é alterado —
 * essa transformação acontece só na hora de montar o payload de envio.
 */
export function buildOllamaPayloadMessages(history: ChatMessage[]): OllamaApiMessage[] {
  return history.map((message) => {
    const attachments = message.attachments ?? [];
    const images = attachments
      .filter((a) => a.type === "image")
      .map((a) => a.data);

    const textAttachments = attachments.filter((a) => a.type !== "image");
    const attachmentBlocks = textAttachments
      .map((a) => `[Anexo: ${a.name}]\n${a.data}\n[/Anexo]`)
      .join("\n\n");

    const content = attachmentBlocks
      ? [message.content, attachmentBlocks].filter(Boolean).join("\n\n")
      : message.content;

    const apiMessage: OllamaApiMessage = { role: message.role, content };
    if (images.length > 0) apiMessage.images = images;
    return apiMessage;
  });
}
