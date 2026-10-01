export type ThemePreference = "light" | "dark" | "system";

const THEME_KEY = "theme";

export function getStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return "system";
}

export function applyTheme(pref: ThemePreference) {
  if (typeof document === "undefined") return;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const shouldBeDark = pref === "dark" || (pref === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", shouldBeDark);
}

export function setTheme(pref: ThemePreference) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
}
