import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api";
import { createQueryClient, shouldRetry } from "./query";

describe("shouldRetry", () => {
  test("retries a server or network failure once", () => {
    expect(shouldRetry(0, new ApiError(500, "boom"))).toBe(true);
    expect(shouldRetry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(1, new ApiError(500, "boom"))).toBe(false);
  });

  test("never retries a client error such as a 404", () => {
    expect(shouldRetry(0, new ApiError(404, "Quote 7 not found"))).toBe(false);
    expect(shouldRetry(0, new ApiError(400, "bad"))).toBe(false);
  });

  test("is the app client's default", () => {
    expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(shouldRetry);
  });
});
