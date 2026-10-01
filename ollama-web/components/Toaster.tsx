"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { ToastItem, subscribeToasts, dismissToast } from "@/lib/toast";

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const COLORS = {
  success: "text-green-600 dark:text-green-400",
  error: "text-red-600 dark:text-red-400",
  info: "text-accent",
};

export default function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setItems), []);

  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {items.map((t) => {
        const Icon = ICONS[t.type];
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-2.5 px-3.5 py-3 rounded-xl border border-border-light dark:border-border-dark bg-surface-light-raised dark:bg-surface-dark-raised shadow-lg animate-fadeIn"
          >
            <Icon size={16} className={`shrink-0 mt-0.5 ${COLORS[t.type]}`} />
            <p className="text-sm text-ink-light dark:text-ink-dark flex-1 leading-snug">
              {t.message}
            </p>
            <button
              onClick={() => dismissToast(t.id)}
              className="shrink-0 p-0.5 rounded text-ink-muted hover:text-ink-light dark:hover:text-ink-dark"
              aria-label="Fechar notificação"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
