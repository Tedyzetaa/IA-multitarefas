"use client";

import { useEffect, useRef, useState, DragEvent } from "react";
import { PanelLeftOpen, Sparkles, UploadCloud, ArrowDown } from "lucide-react";
import { ChatMessage, Artifact, ChatAttachment } from "@/lib/types";
import Message from "./Message";
import ModelSelector from "./ModelSelector";
import InputBox, { InputBoxHandle } from "./InputBox";
import { ImageGenMode } from "@/lib/nexusBridge";

interface ChatAreaProps {
  messages: ChatMessage[];
  artifacts: Artifact[];
  selectedModel: string;
  onModelChange: (m: string) => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onGenerateVideo?: (text: string, image?: ChatAttachment) => void;
  onGenerateImage?: (text: string, mode: ImageGenMode, image?: ChatAttachment) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onOpenArtifact: (a: Artifact) => void;
  onEditMessage: (id: string, newContent: string) => void;
  onDeleteMessage: (id: string) => void;
  isStreaming: boolean;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
}

/** Distância (px) do fundo dentro da qual consideramos que o usuário "está no fim". */
const NEAR_BOTTOM_THRESHOLD = 120;

export default function ChatArea({
  messages,
  artifacts,
  selectedModel,
  onModelChange,
  onSend,
  onGenerateVideo,
  onGenerateImage,
  onStop,
  onRegenerate,
  onOpenArtifact,
  onEditMessage,
  onDeleteMessage,
  isStreaming,
  sidebarCollapsed,
  onExpandSidebar,
}: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<InputBoxHandle>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const dragCounter = useRef(0);

  // Auto-scroll "inteligente": só acompanha o streaming automaticamente se
  // o usuário já estava perto do fim. Se ele rolou pra cima pra reler algo,
  // não puxamos a tela de volta a cada token — isso é o que mais irrita em
  // clones de chat malfeitos.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < NEAR_BOTTOM_THRESHOLD) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, messages[messages.length - 1]?.content]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowJumpToBottom(distanceFromBottom > NEAR_BOTTOM_THRESHOLD);
  };

  const jumpToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Drag & drop de arquivos em qualquer ponto da área de chat.
  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragCounter.current += 1;
    setIsDraggingOver(true);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDraggingOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      inputRef.current?.addFiles(files);
      inputRef.current?.focus();
    }
  };

  return (
    <div
      className="flex flex-col flex-1 h-full overflow-hidden bg-surface-light dark:bg-surface-dark glass-panel transition-colors"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingOver && (
        <div className="absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-accent-soft/90 dark:bg-accent/10 backdrop-blur-sm pointer-events-none animate-fadeIn">
          <UploadCloud size={32} className="text-accent" />
          <p className="text-sm font-medium text-accent">Solte os arquivos aqui</p>
          <p className="text-xs text-ink-muted">Imagens, PDF ou ZIP</p>
        </div>
      )}

      <header className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border-light dark:border-border-dark">
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

      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative">
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
            <p className="text-xs text-ink-muted">
              Dica: você pode colar (Ctrl+V) ou arrastar imagens direto aqui
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
                onEdit={m.role === "user" ? (text) => onEditMessage(m.id, text) : undefined}
                onDelete={() => onDeleteMessage(m.id)}
                isLast={i === messages.length - 1}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {showJumpToBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-28 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-light-raised dark:bg-surface-dark-raised border border-border-light dark:border-border-dark shadow-md text-xs text-ink-light dark:text-ink-dark hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors animate-fadeIn"
        >
          <ArrowDown size={13} />
          Ir para o fim
        </button>
      )}

      <div className="shrink-0 border-t border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark glass-panel">
        <InputBox
          ref={inputRef}
          onSend={onSend}
          onGenerateVideo={onGenerateVideo}
          onGenerateImage={onGenerateImage}
          onStop={onStop}
          isStreaming={isStreaming}
        />
      </div>
    </div>
  );
}
