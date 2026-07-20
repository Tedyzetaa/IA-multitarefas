"use client";

import { PanelLeftClose, PanelLeftOpen, Plus, MessageSquare, Settings, Trash2 } from "lucide-react";
import { Conversation } from "@/lib/types";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
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
  onOpenSettings,
}: SidebarProps) {
  if (collapsed) {
    return (
      <div className="hidden md:flex flex-col items-center w-14 py-3 border-r border-border-light dark:border-border-dark bg-surface-light-sunken dark:bg-surface-dark-sunken">
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

  const groups = groupByTime(conversations);

  return (
    <div className="hidden md:flex flex-col w-72 shrink-0 border-r border-border-light dark:border-border-dark bg-surface-light-sunken dark:bg-surface-dark-sunken">
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

      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        {groups.length === 0 && (
          <p className="px-3 text-xs text-ink-muted">Nenhuma conversa ainda.</p>
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
                  onClick={() => onSelect(c.id)}
                >
                  <MessageSquare size={14} className="shrink-0" />
                  <span className="truncate flex-1">{c.title}</span>
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
