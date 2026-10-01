"use client";

import { useEffect, useState, useRef } from "react";
import { X, Trash2, Download, Sun, Moon, Monitor, ShieldCheck, ShieldAlert } from "lucide-react";
import {
  AppSettings,
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  SAFE_VIDEO_SETTINGS,
  MAX_VIDEO_SETTINGS,
} from "@/lib/settings";
import { ThemePreference, getStoredTheme, setTheme as persistTheme } from "@/lib/theme";
import {
  AppearanceSettings,
  PRESET_THEMES,
  loadAppearance,
  saveAppearance,
  applyAppearance,
} from "@/lib/appearance";
import { exportAllConversationsAsJSON, clearAllConversations } from "@/lib/db";
import { toast } from "@/lib/toast";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onDataCleared: () => void;
}

export default function SettingsModal({ open, onClose, onDataCleared }: SettingsModalProps) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [theme, setThemeState] = useState<ThemePreference>("system");
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance());
  const [confirmingClear, setConfirmingClear] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSettings(loadSettings());
      setThemeState(getStoredTheme());
      setAppearance(loadAppearance());
      setConfirmingClear(false);
    }
  }, [open]);

  // Aplicar tema em tempo real
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  if (!open) return null;

  const handleSave = () => {
    saveSettings(settings);
    const appearanceSaved = saveAppearance(appearance);
    if (!appearanceSaved) {
      toast(
        "Configurações salvas, mas o papel de parede é grande demais para guardar localmente. Tente uma imagem menor.",
        "error"
      );
      onClose();
      return;
    }
    toast("Configurações salvas.", "success");
    onClose();
  };

  const handleThemeChange = (t: ThemePreference) => {
    setThemeState(t);
    persistTheme(t);
  };

  const handleAppearanceChange = (updates: Partial<AppearanceSettings>) => {
    const newAppearance = { ...appearance, ...updates };
    setAppearance(newAppearance);
  };

  const handleWallpaperUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validar tamanho (máx 8MB de arquivo original; a imagem é comprimida
    // abaixo antes de ser guardada, então isso é só um teto razoável)
    if (file.size > 8 * 1024 * 1024) {
      toast("Arquivo muito grande (máx 8MB).", "error");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;

      // Redimensiona/comprime via canvas antes de guardar: o localStorage
      // tem cota de ~5MB por site, e uma imagem grande em base64 (que
      // infla ~33% o tamanho) estoura isso facilmente — o upload "funciona"
      // na hora mas some ao recarregar a página, silenciosamente.
      const img = document.createElement("img");
      img.onload = () => {
        const MAX_DIM = 1920;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          toast("Não foi possível processar a imagem.", "error");
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL("image/jpeg", 0.82);
        handleAppearanceChange({ wallpaperUrl: compressed });
        toast("Papel de parede carregado!", "success");
      };
      img.onerror = () => toast("Não foi possível ler essa imagem.", "error");
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleExport = async () => {
    try {
      const json = await exportAllConversationsAsJSON();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ollama-chat-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Backup exportado.", "success");
    } catch {
      toast("Não foi possível exportar o backup.", "error");
    }
  };

  const handleClearAll = async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    await clearAllConversations();
    toast("Todo o histórico foi apagado.", "success");
    setConfirmingClear(false);
    onDataCleared();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40 animate-fadeIn" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-border-light dark:border-border-dark bg-surface-light-raised dark:bg-surface-dark-raised shadow-xl animate-fadeIn max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-light dark:border-border-dark">
          <h2 className="text-sm font-semibold text-ink-light dark:text-ink-dark">
            Configurações
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken"
            aria-label="Fechar"
          >
            <X size={16} className="text-ink-muted" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-6">
          {/* Tema - Dark/Light */}
          <div>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
              Modo Escuro/Claro
            </label>
            <div className="flex gap-2">
              {(
                [
                  { value: "light", label: "Claro", Icon: Sun },
                  { value: "dark", label: "Escuro", Icon: Moon },
                  { value: "system", label: "Sistema", Icon: Monitor },
                ] as const
              ).map(({ value, label, Icon }) => (
                <button
                  key={value}
                  onClick={() => handleThemeChange(value)}
                  className={`flex-1 flex flex-col items-center gap-1 py-2.5 rounded-lg border text-xs transition-colors ${
                    theme === value
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border-light dark:border-border-dark text-ink-muted hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken"
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Tema de Cor */}
          <div>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
              Cor de Destaque
            </label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(PRESET_THEMES).map(([themeKey, theme]) => (
                <button
                  key={themeKey}
                  onClick={() => handleAppearanceChange({ theme: themeKey as any })}
                  className={`aspect-square rounded-lg border-2 transition-all ${
                    appearance.theme === themeKey
                      ? "border-ink-light dark:border-ink-dark scale-105"
                      : "border-border-light dark:border-border-dark"
                  }`}
                  style={{ backgroundColor: `rgb(${theme.accent})` }}
                  title={theme.name}
                />
              ))}
              <button
                onClick={() => handleAppearanceChange({ theme: "custom" })}
                className={`aspect-square rounded-lg border-2 flex items-center justify-center transition-all ${
                  appearance.theme === "custom"
                    ? "border-ink-light dark:border-ink-dark scale-105"
                    : "border-border-light dark:border-border-dark"
                }`}
              >
                <span className="text-xs font-semibold text-ink-muted">#</span>
              </button>
            </div>
            {appearance.theme === "custom" && (
              <div className="mt-2">
                <input
                  type="color"
                  value={appearance.customAccentColor || "#D97757"}
                  onChange={(e) =>
                    handleAppearanceChange({ customAccentColor: e.target.value })
                  }
                  className="w-12 h-10 rounded-lg cursor-pointer"
                />
              </div>
            )}
          </div>

          {/* Papel de Parede */}
          <div>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
              Papel de Parede
            </label>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full px-4 py-2 rounded-lg border-2 border-dashed border-border-light dark:border-border-dark hover:border-accent hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors text-sm text-ink-muted"
            >
              {appearance.wallpaperUrl ? "Mudar papel de parede" : "Carregar imagem"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleWallpaperUpload}
              className="hidden"
            />

            {appearance.wallpaperUrl && (
              <div className="mt-3 space-y-3">
                {/* Intensidade */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-ink-muted">Intensidade</label>
                    <span className="text-xs text-ink-light dark:text-ink-dark">
                      {appearance.wallpaperOpacity}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={appearance.wallpaperOpacity}
                    onChange={(e) =>
                      handleAppearanceChange({
                        wallpaperOpacity: parseInt(e.target.value),
                      })
                    }
                    className="w-full accent-accent"
                  />
                </div>

                {/* Desfoque */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-ink-muted">Desfoque</label>
                    <span className="text-xs text-ink-light dark:text-ink-dark">
                      {appearance.wallpaperBlur}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={20}
                    step={1}
                    value={appearance.wallpaperBlur}
                    onChange={(e) =>
                      handleAppearanceChange({
                        wallpaperBlur: parseInt(e.target.value),
                      })
                    }
                    className="w-full accent-accent"
                  />
                </div>

                <button
                  onClick={() =>
                    handleAppearanceChange({ wallpaperUrl: undefined })
                  }
                  className="w-full px-3 py-2 rounded-lg text-xs text-red-600 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                >
                  Remover papel de parede
                </button>
              </div>
            )}
          </div>

          {/* Servidor Ollama */}
          <div>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
              Endereço do servidor Ollama
            </label>
            <input
              type="text"
              value={settings.ollamaUrl}
              onChange={(e) => setSettings((s) => ({ ...s, ollamaUrl: e.target.value }))}
              placeholder="http://127.0.0.1:11434"
              className="w-full px-3 py-2 rounded-lg border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark text-sm outline-none focus:border-accent"
            />
            <p className="mt-1 text-[11px] text-ink-muted">
              Deixe em branco para usar o padrão local (127.0.0.1:11434).
            </p>
          </div>

          {/* System prompt */}
          <div>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
              Prompt de sistema padrão
            </label>
            <textarea
              value={settings.systemPrompt}
              onChange={(e) => setSettings((s) => ({ ...s, systemPrompt: e.target.value }))}
              placeholder="Ex.: Responda sempre em português, de forma direta e técnica."
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark text-sm outline-none focus:border-accent resize-none"
            />
          </div>

          {/* Temperature */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-ink-muted uppercase tracking-wide">
                Temperatura
              </label>
              <span className="text-xs font-mono text-ink-light dark:text-ink-dark">
                {settings.temperature.toFixed(1)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={settings.temperature}
              onChange={(e) =>
                setSettings((s) => ({ ...s, temperature: parseFloat(e.target.value) }))
              }
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-[11px] text-ink-muted mt-1">
              <span>Mais preciso</span>
              <span>Mais criativo</span>
            </div>
          </div>

          {/* Dublagem de áudio */}
          <div className="pt-2 border-t border-border-light dark:border-border-dark">
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
              Dublagem expressiva
            </label>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-[11px] text-ink-muted uppercase tracking-wide">
                  Idioma alvo
                </span>
                <select
                  value={settings.audioDubbing.targetLanguage}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      audioDubbing: { ...s.audioDubbing, targetLanguage: e.target.value as any },
                    }))
                  }
                  className="w-full px-3 py-2 rounded-lg border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark text-sm outline-none focus:border-accent"
                >
                  <option value="pt-BR">Português (Brasil)</option>
                  <option value="en-US">Inglês (EUA)</option>
                  <option value="es-ES">Espanhol</option>
                  <option value="fr-FR">Francês</option>
                  <option value="de-DE">Alemão</option>
                  <option value="ja-JP">Japonês</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[11px] text-ink-muted uppercase tracking-wide">
                  Provedor de voz
                </span>
                <select
                  value={settings.audioDubbing.voiceProvider}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      audioDubbing: { ...s.audioDubbing, voiceProvider: e.target.value as any },
                    }))
                  }
                  className="w-full px-3 py-2 rounded-lg border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark text-sm outline-none focus:border-accent"
                >
                  <option value="elevenlabs">ElevenLabs</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[11px] text-ink-muted uppercase tracking-wide">
                  Voice ID (ElevenLabs)
                </span>
                <input
                  type="text"
                  value={settings.audioDubbing.voiceId ?? ""}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      audioDubbing: { ...s.audioDubbing, voiceId: e.target.value.trim() },
                    }))
                  }
                  placeholder="ex.: JBFqnCBsd6RMkjVDRZzb"
                  className="w-full px-3 py-2 rounded-lg border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark text-sm outline-none focus:border-accent"
                />
              </label>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-muted uppercase tracking-wide">
                  <span>Estabilidade</span>
                  <span>{settings.audioDubbing.stability.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.01}
                  value={settings.audioDubbing.stability}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      audioDubbing: { ...s.audioDubbing, stability: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-accent"
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-muted uppercase tracking-wide">
                  <span>Similaridade</span>
                  <span>{settings.audioDubbing.similarityBoost.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.01}
                  value={settings.audioDubbing.similarityBoost}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      audioDubbing: { ...s.audioDubbing, similarityBoost: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-accent"
                />
              </div>
            </div>
          </div>

          {/* Geração de vídeo (ComfyUI / LTX-Video) */}
          <div className="pt-2 border-t border-border-light dark:border-border-dark">
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
              Vídeo (ComfyUI / LTX-Video)
            </label>

            <button
              type="button"
              onClick={() =>
                setSettings((s) => ({ ...s, videoSafeMode: !s.videoSafeMode }))
              }
              className={`w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                settings.videoSafeMode
                  ? "border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-800"
                  : "border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800"
              }`}
            >
              {settings.videoSafeMode ? (
                <ShieldCheck size={16} className="shrink-0 mt-0.5 text-green-600" />
              ) : (
                <ShieldAlert size={16} className="shrink-0 mt-0.5 text-amber-600" />
              )}
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-light dark:text-ink-dark">
                  Modo seguro para VRAM 6GB{" "}
                  {settings.videoSafeMode ? "(ativado)" : "(desativado)"}
                </span>
                <span className="block text-[11px] text-ink-muted mt-0.5">
                  {settings.videoSafeMode
                    ? `Trava em ${SAFE_VIDEO_SETTINGS.width}x${SAFE_VIDEO_SETTINGS.height}, ${SAFE_VIDEO_SETTINGS.length} frames, denoise ${SAFE_VIDEO_SETTINGS.denoise.toFixed(2)} — validado sem OOM numa RTX 3050 6GB. Toque para liberar edição manual.`
                    : "Edição manual liberada, ainda com teto de segurança abaixo. Valores altos podem causar OOM em GPUs de 6GB."}
                </span>
              </span>
            </button>

            {!settings.videoSafeMode && (
              <div className="mt-3 space-y-3 pl-1">
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label="Largura (width)"
                    value={settings.video.width}
                    min={64}
                    max={MAX_VIDEO_SETTINGS.width}
                    step={16}
                    onChange={(v) =>
                      setSettings((s) => ({ ...s, video: { ...s.video, width: v } }))
                    }
                  />
                  <NumberField
                    label="Altura (height)"
                    value={settings.video.height}
                    min={64}
                    max={MAX_VIDEO_SETTINGS.height}
                    step={16}
                    onChange={(v) =>
                      setSettings((s) => ({ ...s, video: { ...s.video, height: v } }))
                    }
                  />
                  <NumberField
                    label="Frames (length)"
                    value={settings.video.length}
                    min={9}
                    max={MAX_VIDEO_SETTINGS.length}
                    step={1}
                    onChange={(v) =>
                      setSettings((s) => ({ ...s, video: { ...s.video, length: v } }))
                    }
                  />
                  <NumberField
                    label="Denoise"
                    value={settings.video.denoise}
                    min={0.1}
                    max={MAX_VIDEO_SETTINGS.denoise}
                    step={0.05}
                    onChange={(v) =>
                      setSettings((s) => ({ ...s, video: { ...s.video, denoise: v } }))
                    }
                  />
                </div>
                <p className="text-[11px] text-ink-muted">
                  Teto absoluto: {MAX_VIDEO_SETTINGS.width}x{MAX_VIDEO_SETTINGS.height},{" "}
                  {MAX_VIDEO_SETTINGS.length} frames, denoise{" "}
                  {MAX_VIDEO_SETTINGS.denoise.toFixed(2)} — respeitado mesmo aqui.
                </p>
              </div>
            )}
          </div>

          {/* Dados */}
          <div className="pt-2 border-t border-border-light dark:border-border-dark space-y-2">
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
              Seus dados
            </label>
            <button
              onClick={handleExport}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-ink-light dark:text-ink-dark border border-border-light dark:border-border-dark hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
            >
              <Download size={15} />
              Exportar todas as conversas (.json)
            </button>
            <button
              onClick={handleClearAll}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                confirmingClear
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "text-red-600 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/30"
              }`}
            >
              <Trash2 size={15} />
              {confirmingClear ? "Confirmar: apagar tudo" : "Apagar todo o histórico"}
            </button>
            <p className="text-[11px] text-ink-muted">
              Tudo fica salvo localmente no seu navegador (IndexedDB) — nada é enviado para
              fora da sua máquina.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border-light dark:border-border-dark">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-ink-muted hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-accent hover:bg-accent-hover text-white transition-colors"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] text-ink-muted mb-1">
        {label} ({min}–{max})
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = parseFloat(e.target.value);
          if (Number.isNaN(raw)) return;
          onChange(Math.min(Math.max(raw, min), max));
        }}
        className="w-full px-3 py-1.5 rounded-lg border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark text-sm outline-none focus:border-accent"
      />
    </label>
  );
}
