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
  // null until resolved after mount. The server and the FIRST client render must
  // agree (both "dark", the SSR default) or React throws a hydration mismatch, so
  // we do NOT read localStorage/prefers-color-scheme during render. The real theme
  // is applied in the mount effect below; the pre-hydration inline script in
  // layout.tsx has already set data-theme for CSS, so there is no visual flash,
  // only a one-frame correction of the theme-toggle icon.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    // resolve the client-only theme once, after hydration (see the null-initial
    // note above). This is the documented "read a browser value on mount" case.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(readStoredTheme());
  }, []);

  useEffect(() => {
    if (theme === null) return; // leave the pre-hydration script's data-theme in place
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const resolved: Theme = theme ?? "dark";
  const value: ThemeContextValue = {
    theme: resolved,
    isDark: resolved === "dark",
    isLight: resolved === "light",
    toggle: () =>
      setTheme((t) => {
        const next: Theme = (t ?? "dark") === "dark" ? "light" : "dark";
        try {
          window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // ignore quota / storage-disabled errors
        }
        return next;
      }),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
