import { describe, it, expect } from "vitest";
import { getErrorMessage, isLimitError } from "../utils/error-utils.js";

describe("getErrorMessage", () => {
  it("returns message from Error instance", () => {
    const err = new Error("Something went wrong");
    expect(getErrorMessage(err)).toBe("Something went wrong");
  });

  it("returns fallback when err is not Error and fallback is provided", () => {
    expect(getErrorMessage("string error", "fallback")).toBe("fallback");
    expect(getErrorMessage(42, "fallback")).toBe("fallback");
    expect(getErrorMessage(null, "fallback")).toBe("fallback");
    expect(getErrorMessage(undefined, "fallback")).toBe("fallback");
  });

  it("returns String(err) when err is not Error and no fallback", () => {
    expect(getErrorMessage("string error")).toBe("string error");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("ignores fallback when err is Error", () => {
    const err = new Error("actual message");
    expect(getErrorMessage(err, "fallback")).toBe("actual message");
  });

  it("handles Error subclasses", () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }
    const err = new CustomError("custom");
    expect(getErrorMessage(err)).toBe("custom");
  });

  it("handles empty string fallback", () => {
    expect(getErrorMessage(42, "")).toBe("");
  });
});

describe("isLimitError", () => {
  it("returns true for HTTP 429 status", () => {
    expect(isLimitError({ status: 429 })).toBe(true);
    expect(isLimitError({ statusCode: 429 })).toBe(true);
    expect(isLimitError({ status: "429" })).toBe(true);
  });

  it("returns true for rate limit in message", () => {
    expect(isLimitError(new Error("Rate limit exceeded"))).toBe(true);
    expect(isLimitError(new Error("rate limit hit"))).toBe(true);
    expect(isLimitError(new Error("rate limit"))).toBe(true);
  });

  it("returns true for overloaded in message", () => {
    expect(isLimitError(new Error("Overloaded"))).toBe(true);
    expect(isLimitError(new Error("Service overloaded, try again later"))).toBe(true);
  });

  it("returns true for add more tokens", () => {
    expect(isLimitError(new Error("add more tokens to continue"))).toBe(true);
    expect(isLimitError(new Error("Please add more tokens"))).toBe(true);
  });

  it("returns true for quota exceeded", () => {
    expect(isLimitError(new Error("quota exceeded"))).toBe(true);
    expect(isLimitError(new Error("Quota exceeded for this API key"))).toBe(true);
  });

  it("returns true for too many requests", () => {
    expect(isLimitError(new Error("Too many requests"))).toBe(true);
  });

  it("returns true for resource exhausted", () => {
    expect(isLimitError(new Error("Resource exhausted"))).toBe(true);
  });

  it("returns true when 429 in message string", () => {
    expect(isLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isLimitError("Error: 429 rate limit")).toBe(true);
  });

  it("returns true for stderr with limit pattern", () => {
    expect(isLimitError({ stderr: "rate limit exceeded", message: "Agent failed" })).toBe(true);
    expect(isLimitError({ stderr: "overloaded" })).toBe(true);
  });

  it("returns false for non-limit errors", () => {
    expect(isLimitError(new Error("Authentication required"))).toBe(false);
    expect(isLimitError(new Error("Invalid API key"))).toBe(false);
    expect(isLimitError(new Error("Connection timeout"))).toBe(false);
    expect(isLimitError(new Error("Something went wrong"))).toBe(false);
    expect(isLimitError({ status: 401 })).toBe(false);
    expect(isLimitError({ status: 500 })).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isLimitError(null)).toBe(false);
    expect(isLimitError(undefined)).toBe(false);
  });
});
