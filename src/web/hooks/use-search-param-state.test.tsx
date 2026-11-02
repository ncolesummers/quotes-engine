import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { applyParamPatch, useSearchParam, useSearchParamState } from "./use-search-param-state";

afterEach(cleanup);

function setup<T>(hook: () => T, path: string) {
  const location = memoryLocation({ path, record: true });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Router hook={location.hook} searchHook={location.searchHook}>
      {children}
    </Router>
  );
  return { ...renderHook(hook, { wrapper }), location };
}

describe("applyParamPatch", () => {
  test("sets, replaces and deletes keys, leaving the rest alone", () => {
    const next = applyParamPatch(new URLSearchParams("q=love&sort=likes&nobook=1"), {
      sort: "postings",
      nobook: null,
      author: "Ken Liu",
      book: "",
      posted: undefined,
    });
    expect(next.toString()).toBe("q=love&sort=postings&author=Ken+Liu");
  });

  test("does not mutate the input", () => {
    const prev = new URLSearchParams("a=1");
    applyParamPatch(prev, { a: null });
    expect(prev.toString()).toBe("a=1");
  });
});

describe("useSearchParamState", () => {
  test("patches several params in one replace", () => {
    const { result, location } = setup(() => useSearchParamState(), "/?q=x&sort=likes");
    expect(result.current[0].get("sort")).toBe("likes");

    act(() => result.current[1]({ sort: null, author: "Seneca" }));
    expect(location.history).toEqual(["/?q=x&author=Seneca"]);
    expect(result.current[0].get("author")).toBe("Seneca");
  });
});

describe("useSearchParam", () => {
  test("reads one param and writes it in place (null deletes)", () => {
    const { result, location } = setup(() => useSearchParam("attention"), "/books");
    expect(result.current[0]).toBeNull();

    act(() => result.current[1]("1"));
    expect(result.current[0]).toBe("1");
    expect(location.history?.at(-1)).toBe("/books?attention=1");

    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect(location.history?.at(-1)).toBe("/books");
    expect(location.history).toHaveLength(1);
  });
});
