import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  type ThemePreference,
  type ResolvedTheme,
  getStoredTheme,
  getResolvedTheme,
  applyTheme,
} from "../lib/theme";

interface ThemeContextValue {
  /** User preference: light, dark, or system. */
  preference: ThemePreference;
  /** Resolved theme: actual light or dark. */
  resolved: ResolvedTheme;
  /** Set theme preference and persist. */
  setTheme: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  const setTheme = useCallback((next: ThemePreference) => {
    applyTheme(next);
    setPreference(next);
    setResolved(getResolvedTheme());
  }, []);

  useEffect(() => {
    const pref = getStoredTheme();
    const res = getResolvedTheme();
    setPreference(pref);
    setResolved(res);
    document.documentElement.setAttribute("data-theme", res);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (pref === "system") {
        const newRes = media.matches ? "dark" : "light";
        setResolved(newRes);
        document.documentElement.setAttribute("data-theme", newRes);
      }
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const value: ThemeContextValue = {
    preference,
    resolved,
    setTheme,
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
