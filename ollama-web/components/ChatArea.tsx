"use client";

import { useEffect, useRef } from "react";
import { PanelLeftOpen, Sparkles } from "lucide-react";
import { ChatMessage, Artifact } from "@/lib/types";
import Message from "./Message";
import ModelSelector from "./ModelSelector";
import InputBox from "./InputBox";

interface ChatAreaProps {
  messages: ChatMessage[];
  artifacts: Artifact[];
  selectedModel: string;
  onModelChange: (m: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onOpenArtifact: (a: Artifact) => void;
  isStreaming: boolean;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
}

export default function ChatArea({
  messages,
  artifacts,
  selectedModel,
  onModelChange,
  onSend,
  onStop,
  onRegenerate,
  onOpenArtifact,
  isStreaming,
  sidebarCollapsed,
  onExpandSidebar,
}: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.content]);

  return (
    <div className="flex flex-col flex-1 min-w-0 bg-surface-light dark:bg-surface-dark transition-colors">
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border-light dark:border-border-dark">
        {sidebarCollapsed && (
          <button
            onClick={onExpandSidebar}
            className="md:hidden p-1.5 rounded-md hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken"
            aria-label="Abrir barra lateral"
          >
            <PanelLeftOpen size={18} className="text-ink-muted" />
          </button>
        )}
        <ModelSelector selectedModel={selectedModel} onChange={onModelChange} />
      </header>

      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 px-4">
            <div className="w-12 h-12 rounded-full bg-accent flex items-center justify-center">
              <Sparkles size={22} className="text-white" />
            </div>
            <p className="text-lg font-medium text-ink-light dark:text-ink-dark">
              Como posso ajudar você hoje?
            </p>
            <p className="text-sm text-ink-muted">
              Conectado a {selectedModel || "nenhum modelo"} via Ollama local
            </p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto">
            {messages.map((m, i) => (
              <Message
                key={m.id}
                message={m}
                artifacts={artifacts.filter((a) => a.messageId === m.id)}
                onOpenArtifact={onOpenArtifact}
                onRegenerate={m.role === "assistant" ? onRegenerate : undefined}
                isLast={i === messages.length - 1}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <InputBox onSend={onSend} onStop={onStop} isStreaming={isStreaming} />
    </div>
  );
}
