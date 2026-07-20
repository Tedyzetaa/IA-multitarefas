export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** true enquanto o texto ainda está sendo transmitido via stream */
  streaming?: boolean;
  /** modelo usado para gerar a resposta (apenas assistant) */
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
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
