/**
 * Sistema centralizado de temas, cores e papel de parede.
 * Persiste em localStorage e aplica via CSS custom properties.
 */

export type ThemeName = "clay" | "ocean" | "forest" | "violet" | "rose" | "amber" | "graphite" | "custom";

export interface ThemeColor {
  name: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
}

export interface AppearanceSettings {
  theme: ThemeName;
  customAccentColor?: string; // hex, usado quando theme === "custom"
  wallpaperUrl?: string;
  wallpaperOpacity: number; // 0-100
  wallpaperBlur: number; // px
}

export const PRESET_THEMES: Record<Exclude<ThemeName, "custom">, ThemeColor> = {
  clay: {
    name: "Argila",
    accent: "217 119 87",
    accentHover: "196 101 63",
    accentSoft: "243 227 219",
  },
  ocean: {
    name: "Oceano",
    accent: "14 165 233",
    accentHover: "2 132 199",
    accentSoft: "224 242 254",
  },
  forest: {
    name: "Floresta",
    accent: "16 185 129",
    accentHover: "5 150 105",
    accentSoft: "209 250 229",
  },
  violet: {
    name: "Violeta",
    accent: "139 92 246",
    accentHover: "124 58 237",
    accentSoft: "237 233 254",
  },
  rose: {
    name: "Rosa",
    accent: "244 63 94",
    accentHover: "225 29 72",
    accentSoft: "255 228 230",
  },
  amber: {
    name: "Âmbar",
    accent: "245 158 11",
    accentHover: "217 119 6",
    accentSoft: "254 243 199",
  },
  graphite: {
    name: "Grafite",
    accent: "107 114 128",
    accentHover: "75 85 99",
    accentSoft: "243 244 246",
  },
};

const STORAGE_KEY = "appearance-settings";
const DEFAULT_SETTINGS: AppearanceSettings = {
  theme: "clay",
  wallpaperOpacity: 20,
  wallpaperBlur: 8,
};

export function loadAppearance(): AppearanceSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // Ignora erros de parsing silenciosamente
  }
  return DEFAULT_SETTINGS;
}

/** Retorna true se salvou com sucesso. false = provavelmente estourou a cota
 * do localStorage (comum quando o papel de parede em base64 é grande). */
export function saveAppearance(settings: AppearanceSettings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function getThemeColor(appearance: AppearanceSettings): ThemeColor {
  if (appearance.theme === "custom" && appearance.customAccentColor) {
    // Converter hex para RGB se necessário
    const rgb = appearance.customAccentColor.startsWith("#")
      ? hexToRgb(appearance.customAccentColor)
      : appearance.customAccentColor;
    return {
      name: "Personalizada",
      accent: rgb,
      accentHover: adjustRgbBrightness(rgb, -20),
      accentSoft: adjustRgbBrightness(rgb, 85),
    };
  }
  return PRESET_THEMES[appearance.theme as Exclude<ThemeName, "custom">];
}

/** Converte RGB string (e.g. "14 165 233") para versão mais clara */
function adjustRgbBrightness(rgb: string, delta: number): string {
  const [r, g, b] = rgb.split(" ").map(Number);
  const adjusted = [
    Math.max(0, Math.min(255, r + delta)),
    Math.max(0, Math.min(255, g + delta)),
    Math.max(0, Math.min(255, b + delta)),
  ];
  return adjusted.join(" ");
}

/** Converte hex color para RGB string (e.g. "#0EA5E9" → "14 165 233") */
function hexToRgb(hex: string): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `${r} ${g} ${b}`;
}

/**
 * Aplica o tema ao documento. Chama isso após atualizar AppearanceSettings.
 */
export function applyAppearance(appearance: AppearanceSettings): void {
  const root = document.documentElement;
  const color = getThemeColor(appearance);

  // Atualizar CSS variables de cor (agora em formato RGB)
  root.style.setProperty("--color-accent", color.accent);
  root.style.setProperty("--color-accent-hover", color.accentHover);
  root.style.setProperty("--color-accent-soft", color.accentSoft);

  // Atualizar papel de parede
  if (appearance.wallpaperUrl) {
    root.style.setProperty(
      "--wallpaper-url",
      `url('${appearance.wallpaperUrl}')`
    );
    root.style.setProperty(
      "--wallpaper-opacity",
      `${appearance.wallpaperOpacity / 100}`
    );
    root.style.setProperty("--wallpaper-blur", `${appearance.wallpaperBlur}px`);
    root.classList.add("has-wallpaper");
  } else {
    root.classList.remove("has-wallpaper");
  }
}

/** Carrega appearance do localStorage e a aplica imediatamente (para evitar flash) */
export function initializeAppearance(): void {
  const appearance = loadAppearance();
  applyAppearance(appearance);
}
