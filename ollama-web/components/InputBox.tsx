"use client";

import { useEffect, useRef, useState, KeyboardEvent } from "react";
import { ArrowUp, Square, Paperclip } from "lucide-react";

interface InputBoxProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

const MAX_HEIGHT = 240;

export default function InputBox({
  onSend,
  onStop,
  isStreaming,
  disabled,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + "px";
  }, [value]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-2 rounded-2xl border border-border-light dark:border-border-dark bg-surface-light-raised dark:bg-surface-dark-raised px-3 py-2 shadow-sm focus-within:border-accent transition-colors">
          <button
            className="shrink-0 p-2 rounded-lg text-ink-muted hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
            title="Anexar arquivo"
            aria-label="Anexar arquivo"
            type="button"
          >
            <Paperclip size={18} />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder="Envie uma mensagem para o Ollama..."
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 resize-none bg-transparent outline-none text-sm leading-relaxed py-2 text-ink-light dark:text-ink-dark placeholder:text-ink-muted disabled:opacity-50"
            style={{ maxHeight: MAX_HEIGHT }}
          />

          {isStreaming ? (
            <button
              onClick={onStop}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-ink-light dark:bg-ink-dark text-surface-light dark:text-surface-dark hover:opacity-85 transition-opacity"
              aria-label="Parar geração"
              title="Parar"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!value.trim() || disabled}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-accent text-white hover:bg-accent-hover disabled:opacity-30 disabled:hover:bg-accent transition-colors"
              aria-label="Enviar mensagem"
              title="Enviar"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
        <p className="text-center text-[11px] text-ink-muted mt-2">
          As respostas são geradas localmente pelo Ollama. Verifique
          informações importantes.
        </p>
      </div>
    </div>
  );
}
