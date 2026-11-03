import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { DEFAULT_RETRY_SECONDS, remainingSeconds, retrySeconds } from "./rate-limit";

function tooMany(retryAfter: number | null): ApiError {
  return new ApiError({
    status: 429,
    serverMessage: "Too many admin password attempts; try again later",
    retryAfter,
  });
}

describe("retrySeconds", () => {
  it("reads Retry-After", () => {
    expect(retrySeconds(tooMany(3))).toBe(3);
    expect(retrySeconds(tooMany(45))).toBe(45);
  });

  it("defaults to 60 s when Retry-After is missing or unusable", () => {
    expect(DEFAULT_RETRY_SECONDS).toBe(60);
    expect(retrySeconds(tooMany(null))).toBe(60);
    expect(retrySeconds(tooMany(0))).toBe(60);
    expect(retrySeconds(tooMany(-5))).toBe(60);
    expect(retrySeconds(tooMany(Number.NaN))).toBe(60);
  });
});

describe("remainingSeconds (countdown)", () => {
  const until = 10_000;

  it("rounds a partial second up", () => {
    expect(remainingSeconds(until, 7_000)).toBe(3);
    expect(remainingSeconds(until, 7_001)).toBe(3);
    expect(remainingSeconds(until, 8_000)).toBe(2);
    expect(remainingSeconds(until, 9_999)).toBe(1);
  });

  it("stops at 0", () => {
    expect(remainingSeconds(until, until)).toBe(0);
    expect(remainingSeconds(until, until + 5_000)).toBe(0);
  });
});
