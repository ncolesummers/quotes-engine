import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle";
import { THEME_STORAGE_KEY } from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

test("toggles the .dark class on <html> and remembers the choice", () => {
  render(<ThemeToggle />);
  const button = screen.getByRole("button", { name: /dark theme/i });
  fireEvent.click(button);
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

  fireEvent.click(screen.getByRole("button", { name: /light theme/i }));
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
});
