import { MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { applyTheme, type Theme } from "./theme";

function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        applyTheme(next, { persist: true });
        setTheme(next);
      }}
      className="text-muted-foreground hover:text-foreground"
    >
      {theme === "dark" ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
    </Button>
  );
}
