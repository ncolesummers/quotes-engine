import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "./App";

afterEach(() => {
  cleanup();
});

test("renders the app heading", () => {
  render(<App />);
  expect(screen.getByRole("heading", { level: 1, name: /quotes engine/i })).toBeDefined();
});

test("renders a shadcn button", () => {
  render(<App />);
  const button = screen.getByRole("button");
  expect(button.getAttribute("data-slot")).toBe("button");
});
