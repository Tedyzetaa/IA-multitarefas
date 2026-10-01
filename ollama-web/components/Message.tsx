"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  User,
  RotateCcw,
  FileText,
  FileArchive,
  Copy,
  Check,
  Pencil,
  Trash2,
} from "lucide-react";
import { ChatMessage, Artifact } from "@/lib/types";
import { formatBytes } from "@/lib/attachments";
import { toast } from "@/lib/toast";
import CodeBlock from "./CodeBlock";
import VideoCard from "./VideoCard";
import ImageCard from "./ImageCard";

interface MessageProps {
  message: ChatMessage;
  artifacts: Artifact[];
  onOpenArtifact: (artifact: Artifact) => void;
  onRegenerate?: () => void;
  onEdit?: (newContent: string) => void;
  onDelete?: () => void;
  isLast?: boolean;
}

export default function Message({
  message,
  artifacts,
  onOpenArtifact,
  onRegenerate,
  onEdit,
  onDelete,
  isLast,
}: MessageProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Não foi possível copiar.", "error");
    }
  };

  const handleSaveEdit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onEdit?.(trimmed);
    setIsEditing(false);
  };

  return (
    <div
      className={`group flex gap-3 px-4 py-5 animate-fadeIn ${
        isUser ? "" : "bg-transparent"
      }`}
    >
      <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5">
        {isUser ? (
          <div className="w-7 h-7 rounded-full bg-surface-light-sunken dark:bg-surface-dark-sunken flex items-center justify-center">
            <User size={14} className="text-ink-muted" />
          </div>
        ) : (
          <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center">
            <Bot size={14} className="text-white" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium mb-1 text-ink-light dark:text-ink-dark">
          {isUser ? "Você" : message.model || "Assistente"}
        </div>

        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {message.attachments.map((a) =>
              a.type === "image" ? (
                <img
                  key={a.id}
                  src={a.previewUrl}
                  alt={a.name}
                  className="w-20 sm:w-24 h-20 sm:h-24 rounded-lg object-cover border border-border-light dark:border-border-dark attachment-thumb"
                />
              ) : (
                <div
                  key={a.id}
                  className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg border border-border-light dark:border-border-dark bg-surface-light-sunken dark:bg-surface-dark-sunken max-w-[220px]"
                >
                  <div className="shrink-0 w-7 h-7 rounded-md bg-surface-light dark:bg-surface-dark flex items-center justify-center">
                    {a.type === "zip" ? (
                      <FileArchive size={14} className="text-ink-muted" />
                    ) : (
                      <FileText size={14} className="text-ink-muted" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate text-ink-light dark:text-ink-dark">
                      {a.name}
                    </p>
                    <p className="text-[10px] text-ink-muted">{formatBytes(a.size)}</p>
                  </div>
                </div>
              )
            )}
          </div>
        )}

        {message.video ? (
          <VideoCard video={message.video} />
        ) : message.image ? (
          <ImageCard image={message.image} />
        ) : isEditing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, Math.max(2, draft.split("\n").length))}
              className="w-full resize-none rounded-lg border border-accent bg-surface-light dark:bg-surface-dark px-3 py-2 text-sm outline-none"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveEdit}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent hover:bg-accent-hover text-white transition-colors"
              >
                Salvar e reenviar
              </button>
              <button
                onClick={() => {
                  setDraft(message.content);
                  setIsEditing(false);
                }}
                className="px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 prose-pre:bg-transparent prose-pre:m-0">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img({ src, alt, ...props }: any) {
                  return (
                    <img
                      src={src}
                      alt={alt}
                      className="max-w-full h-auto rounded-lg border border-border-light dark:border-border-dark"
                      {...props}
                    />
                  );
                },
                video({ src, ...props }: any) {
                  return (
                    <video
                      src={src}
                      className="max-w-full h-auto rounded-lg border border-border-light dark:border-border-dark"
                      {...props}
                    />
                  );
                },
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || "");
                  const language = match?.[1] || "";
                  const codeString = String(children).replace(/\n$/, "");
                  const isInline = !className;

                  if (isInline) {
                    return (
                      <code className="px-1 py-0.5 rounded bg-surface-light-sunken dark:bg-surface-dark-sunken text-[0.85em]">
                        {children}
                      </code>
                    );
                  }

                  const matchingArtifact = artifacts.find(
                    (a) => a.code.trim() === codeString.trim()
                  );

                  return (
                    <CodeBlock
                      language={language}
                      code={codeString}
                      isArtifact={!!matchingArtifact}
                      onOpenArtifact={
                        matchingArtifact ? () => onOpenArtifact(matchingArtifact) : undefined
                      }
                    />
                  );
                },
              }}
            >
              {message.content || (message.streaming ? "" : "")}
            </ReactMarkdown>

            {message.streaming && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-ink-light dark:bg-ink-dark animate-blink align-middle" />
            )}
          </div>
        )}

        {!isEditing && !message.streaming && !message.video && !message.image && (
          <div className="mt-2 flex items-center gap-3 text-xs text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 hover:text-ink-light dark:hover:text-ink-dark transition-colors"
            >
              {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
              {copied ? "Copiado" : "Copiar"}
            </button>

            {isUser && onEdit && (
              <button
                onClick={() => setIsEditing(true)}
                className="flex items-center gap-1.5 hover:text-ink-light dark:hover:text-ink-dark transition-colors"
              >
                <Pencil size={12} />
                Editar
              </button>
            )}

            {!isUser && isLast && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="flex items-center gap-1.5 hover:text-ink-light dark:hover:text-ink-dark transition-colors"
              >
                <RotateCcw size={12} />
                Tentar novamente
              </button>
            )}

            {onDelete && (
              <button
                onClick={onDelete}
                className="flex items-center gap-1.5 hover:text-red-500 transition-colors"
              >
                <Trash2 size={12} />
                Excluir
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
