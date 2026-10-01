export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

const DURATION_MS = 3200;

let toasts: ToastItem[] = [];
type Listener = (items: ToastItem[]) => void;
let listeners: Listener[] = [];

function emit() {
  listeners.forEach((l) => l(toasts));
}

/** Dispara um toast de qualquer lugar do app, sem precisar de context/provider. */
export function toast(message: string, type: ToastType = "info") {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  toasts = [...toasts, { id, message, type }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, DURATION_MS);
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.push(listener);
  listener(toasts);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}
