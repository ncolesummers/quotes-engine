import { describe, expect, test } from "bun:test";
import { isTypingTarget } from "./use-shortcuts";

function el(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as Element;
}

describe("isTypingTarget", () => {
  test.each([
    ["<input>", true],
    ['<input type="search">', true],
    ["<textarea></textarea>", true],
    ["<select></select>", true],
    ['<input type="checkbox">', false],
    ["<button>Go</button>", false],
    ["<div></div>", false],
  ])("%s -> %p", (html, expected) => {
    expect(isTypingTarget(el(html))).toBe(expected);
  });

  test("null and non-elements are not typing", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});
