export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "quotes-engine:theme";

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

/** The saved choice, else the OS preference. */
export function initialTheme(): Theme {
  const stored = storedTheme();
  if (stored) return stored;
  const prefersDark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

/** Toggle shadcn's `.dark` class on <html>; `persist` saves the choice. */
export function applyTheme(theme: Theme, { persist = false }: { persist?: boolean } = {}): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  if (!persist) return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode); the choice just won't survive a reload.
  }
}
