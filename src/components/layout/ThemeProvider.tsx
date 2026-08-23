"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

interface ThemeContextValue {
  readonly theme: Theme;
  readonly isDark: boolean;
  readonly isLight: boolean;
  readonly toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "demolisher.theme";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    // localStorage access THROWS (not just returns null) when site data is blocked,
    // in a sandboxed iframe, or with storage disabled. This runs in the render-time
    // useState initializer of the app-wrapping provider, so an unguarded throw would
    // white-screen the whole app. Default to "dark" instead.
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
    // no explicit choice yet: honor the OS preference (matches the pre-hydration
    // inline script in layout.tsx, so there is no theme flash on first paint)
    if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  } catch {
    // storage/matchMedia unavailable; fall through to the default
  }
  return "dark";
}

export function ThemeProvider({ children }: { readonly children: React.ReactNode }) {
  // lazy init so the initial state already reflects localStorage, avoiding a
  // synchronous setState inside an effect (cascading render)
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore quota errors
    }
  }, [theme]);

  const value: ThemeContextValue = {
    theme,
    isDark: theme === "dark",
    isLight: theme === "light",
    toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
