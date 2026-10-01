"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  MessageSquare,
  Settings,
  Trash2,
  Search,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { Conversation } from "@/lib/types";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onOpenSettings: () => void;
}

function groupByTime(conversations: Conversation[]) {
  const now = Date.now();
  const day = 86400000;
  const groups: Record<string, Conversation[]> = {
    Hoje: [],
    Ontem: [],
    "Últimos 7 dias": [],
    "Últimos 30 dias": [],
    "Mais antigas": [],
  };

  for (const c of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const diff = now - c.updatedAt;
    if (diff < day) groups["Hoje"].push(c);
    else if (diff < 2 * day) groups["Ontem"].push(c);
    else if (diff < 7 * day) groups["Últimos 7 dias"].push(c);
    else if (diff < 30 * day) groups["Últimos 30 dias"].push(c);
    else groups["Mais antigas"].push(c);
  }

  return Object.entries(groups).filter(([, list]) => list.length > 0);
}

export default function Sidebar({
  conversations,
  activeId,
  collapsed,
  onToggleCollapse,
  onNewChat,
  onSelect,
  onDelete,
  onRename,
  onOpenSettings,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      return c.messages.some((m) => m.content.toLowerCase().includes(q));
    });
  }, [conversations, query]);

  const startRename = (c: Conversation) => {
    setEditingId(c.id);
    setEditValue(c.title);
  };

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (editingId && trimmed) onRename(editingId, trimmed);
    setEditingId(null);
  };

  if (collapsed) {
    return (
      <div className="hidden md:flex flex-col items-center w-14 h-full py-3 border-r border-border-light dark:border-border-dark bg-surface-light-sunken dark:bg-surface-dark-sunken glass-panel">
        <button
          onClick={onToggleCollapse}
          className="p-2 rounded-md hover:bg-surface-light-raised dark:hover:bg-surface-dark-raised"
          aria-label="Expandir barra lateral"
        >
          <PanelLeftOpen size={18} className="text-ink-muted" />
        </button>
        <button
          onClick={onNewChat}
          className="mt-3 p-2 rounded-md bg-accent hover:bg-accent-hover text-white"
          aria-label="Novo chat"
        >
          <Plus size={18} />
        </button>
      </div>
    );
  }

  const groups = groupByTime(filtered);

  return (
    <div className="hidden md:flex flex-col w-72 h-full shrink-0 border-r border-border-light dark:border-border-dark bg-surface-light-sunken dark:bg-surface-dark-sunken glass-panel">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="font-semibold text-sm text-ink-light dark:text-ink-dark px-1">
          Ollama Chat
        </span>
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-md hover:bg-surface-light-raised dark:hover:bg-surface-dark-raised"
          aria-label="Recolher barra lateral"
        >
          <PanelLeftClose size={17} className="text-ink-muted" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          Novo chat
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar conversas..."
            className="w-full pl-8 pr-2 py-1.5 rounded-lg text-sm bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark outline-none focus:border-accent placeholder:text-ink-muted"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        {groups.length === 0 && (
          <p className="px-3 text-xs text-ink-muted">
            {query ? "Nenhuma conversa encontrada." : "Nenhuma conversa ainda."}
          </p>
        )}
        {groups.map(([label, list]) => (
          <div key={label}>
            <p className="px-3 mb-1 text-xs font-medium text-ink-muted uppercase tracking-wide">
              {label}
            </p>
            <div className="space-y-0.5">
              {list.map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${
                    c.id === activeId
                      ? "bg-surface-light-raised dark:bg-surface-dark-raised text-ink-light dark:text-ink-dark"
                      : "text-ink-muted hover:bg-surface-light-raised dark:hover:bg-surface-dark-raised"
                  }`}
                  onClick={() => editingId !== c.id && onSelect(c.id)}
                >
                  <MessageSquare size={14} className="shrink-0" />

                  {editingId === c.id ? (
                    <input
                      ref={editInputRef}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="flex-1 min-w-0 bg-transparent border-b border-accent outline-none text-sm text-ink-light dark:text-ink-dark"
                    />
                  ) : (
                    <span
                      className="truncate flex-1"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(c);
                      }}
                      title="Duplo clique para renomear"
                    >
                      {c.title}
                    </span>
                  )}

                  {editingId === c.id ? (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          commitRename();
                        }}
                        className="p-1 rounded hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken shrink-0"
                        aria-label="Confirmar novo nome"
                      >
                        <Check size={13} className="text-green-600" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(null);
                        }}
                        className="p-1 rounded hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken shrink-0"
                        aria-label="Cancelar"
                      >
                        <X size={13} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(c);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken shrink-0"
                        aria-label="Renomear conversa"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(c.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken shrink-0"
                        aria-label="Excluir conversa"
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-3 py-3 border-t border-border-light dark:border-border-dark">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-ink-muted hover:bg-surface-light-raised dark:hover:bg-surface-dark-raised transition-colors"
        >
          <Settings size={16} />
          Configurações
        </button>
      </div>
    </div>
  );
}
