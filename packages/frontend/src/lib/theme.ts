/** Theme preference: light, dark, or follow system. */
export type ThemePreference = "light" | "dark" | "system";

/** Resolved theme: actual light or dark. */
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "opensprint.theme";

/** Get stored theme preference from localStorage. Defaults to "system". */
export function getStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Save theme preference to localStorage. */
export function setStoredTheme(theme: ThemePreference): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, theme);
}

/** Resolve preference to actual theme (light or dark). */
export function getResolvedTheme(): ResolvedTheme {
  const pref = getStoredTheme();
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply theme to document and persist. Call when user changes theme. */
export function applyTheme(preference: ThemePreference): void {
  setStoredTheme(preference);
  const resolved = getResolvedTheme();
  document.documentElement.setAttribute("data-theme", resolved);
}
