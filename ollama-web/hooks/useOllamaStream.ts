"use client";

import { useCallback, useRef, useState } from "react";
import { ChatMessage, OllamaChatStreamChunk, Role } from "@/lib/types";

const OLLAMA_BASE_URL =
  process.env.NEXT_PUBLIC_OLLAMA_URL || "http://127.0.0.1:11434";

interface StreamCallbacks {
  /** chamado a cada novo pedaço de texto recebido (delta), já acumulado */
  onToken: (fullTextSoFar: string, delta: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

interface SendOptions {
  model: string;
  /** histórico completo, incluindo a mensagem do usuário mais recente */
  messages: Pick<ChatMessage, "role" | "content">[];
}

/**
 * Hook responsável por toda a complexidade de conversar com o Ollama:
 *  - POST em /api/chat com stream: true
 *  - leitura do body via ReadableStream + TextDecoder
 *  - parsing de NDJSON (um objeto JSON por linha)
 *  - acúmulo incremental do texto (efeito "máquina de escrever")
 *  - cancelamento instantâneo via AbortController
 */
export function useOllamaStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const send = useCallback(
    async ({ model, messages }: SendOptions, callbacks: StreamCallbacks) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);

      let fullText = "";

      try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages,
            stream: true,
          }),
        });

        if (!res.ok || !res.body) {
          throw new Error(
            `Ollama respondeu com status ${res.status}. O serviço está rodando em ${OLLAMA_BASE_URL}?`
          );
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Loop de leitura do stream bruto. O Ollama envia NDJSON:
        // cada "\n" separa um objeto JSON completo, mas os chunks de
        // rede não respeitam essa fronteira — por isso mantemos um
        // buffer e só processamos linhas completas.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // última linha pode estar incompleta

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let parsed: OllamaChatStreamChunk;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              continue; // ignora linhas malformadas silenciosamente
            }

            if (parsed.message?.content) {
              fullText += parsed.message.content;
              callbacks.onToken(fullText, parsed.message.content);
            }

            if (parsed.done) {
              callbacks.onDone(fullText);
              setIsStreaming(false);
              abortRef.current = null;
              return;
            }
          }
        }

        // stream terminou sem um chunk "done: true" explícito
        callbacks.onDone(fullText);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // Cancelamento intencional do usuário: finaliza normalmente
          // preservando o que já foi gerado até agora.
          callbacks.onDone(fullText);
        } else {
          callbacks.onError(err as Error);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    []
  );

  return { send, stop, isStreaming };
}

/**
 * Busca a lista de modelos instalados localmente (GET /api/tags).
 */
export async function fetchOllamaModels(): Promise<
  { name: string; details?: Record<string, unknown> }[]
> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  if (!res.ok) throw new Error("Não foi possível listar os modelos do Ollama.");
  const data = await res.json();
  return data.models ?? [];
}
