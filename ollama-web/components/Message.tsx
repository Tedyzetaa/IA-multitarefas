"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User, RotateCcw } from "lucide-react";
import { ChatMessage, Artifact } from "@/lib/types";
import CodeBlock from "./CodeBlock";

interface MessageProps {
  message: ChatMessage;
  artifacts: Artifact[];
  onOpenArtifact: (artifact: Artifact) => void;
  onRegenerate?: () => void;
  isLast?: boolean;
}

export default function Message({
  message,
  artifacts,
  onOpenArtifact,
  onRegenerate,
  isLast,
}: MessageProps) {
  const isUser = message.role === "user";

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

        <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 prose-pre:bg-transparent prose-pre:m-0">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
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
                      matchingArtifact
                        ? () => onOpenArtifact(matchingArtifact)
                        : undefined
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

        {!isUser && !message.streaming && isLast && onRegenerate && (
          <button
            onClick={onRegenerate}
            className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink-light dark:hover:text-ink-dark transition-colors opacity-0 group-hover:opacity-100"
          >
            <RotateCcw size={12} />
            Tentar novamente
          </button>
        )}
      </div>
    </div>
  );
}
