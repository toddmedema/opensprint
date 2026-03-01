import { describe, it, expect } from "vitest";
import {
  getErrorMessage,
  isLimitError,
  isAuthError,
  isOutOfCreditError,
  classifyAgentApiError,
} from "../utils/error-utils.js";

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
    expect(isLimitError(new Error("rate_limit_exceeded"))).toBe(true);
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

  it("returns true for nested error.error.message (Anthropic SDK style)", () => {
    expect(
      isLimitError({
        message: "API error",
        error: { message: "Rate limit exceeded for this API key" },
      })
    ).toBe(true);
    expect(
      isLimitError({
        error: { message: "add more tokens to continue" },
      })
    ).toBe(true);
  });

  it("returns true for statusText with limit pattern", () => {
    expect(isLimitError({ statusText: "Too Many Requests" })).toBe(true);
    expect(isLimitError({ status: 500, statusText: "rate limit exceeded" })).toBe(true);
  });

  it("returns true for error string with limit pattern", () => {
    expect(isLimitError("quota exceeded")).toBe(true);
    expect(isLimitError("Service overloaded")).toBe(true);
  });

  it("returns true for OpenAI error object with rate_limit_exceeded code", () => {
    expect(isLimitError({ message: "rate_limit_exceeded", code: "rate_limit_exceeded" })).toBe(true);
  });

  it("returns true for OpenAI Rate limit message", () => {
    expect(isLimitError(new Error("Rate limit reached for gpt-4o in organization"))).toBe(true);
    expect(isLimitError(new Error("Rate limit exceeded. Please retry after 60 seconds."))).toBe(true);
  });

  it("returns true for OpenAI error body with limit pattern", () => {
    expect(
      isLimitError({
        error: {
          message: "Rate limit exceeded for default-gpt-4o",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      })
    ).toBe(true);
    expect(
      isLimitError({
        message: "OpenAI API error 429",
        error: { message: "rate_limit_exceeded" },
      })
    ).toBe(true);
  });
});

describe("isAuthError", () => {
  it("returns true for HTTP 401 status", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ statusCode: 401 })).toBe(true);
    expect(isAuthError({ status: "401" })).toBe(true);
  });

  it("returns true for invalid API key", () => {
    expect(isAuthError(new Error("Invalid API key"))).toBe(true);
    expect(isAuthError(new Error("API key is invalid"))).toBe(true);
  });

  it("returns true for unauthorized", () => {
    expect(isAuthError(new Error("Unauthorized"))).toBe(true);
    expect(isAuthError(new Error("401 Unauthorized"))).toBe(true);
  });

  it("returns true for authentication required", () => {
    expect(isAuthError(new Error("Authentication required"))).toBe(true);
  });

  it("returns false for non-auth errors", () => {
    expect(isAuthError(new Error("Rate limit exceeded"))).toBe(false);
    expect(isAuthError(new Error("Connection timeout"))).toBe(false);
    expect(isAuthError({ status: 429 })).toBe(false);
  });
});

describe("isOutOfCreditError", () => {
  it("returns true for out of credit", () => {
    expect(isOutOfCreditError(new Error("Out of credit"))).toBe(true);
    expect(isOutOfCreditError(new Error("You are out of credit"))).toBe(true);
  });

  it("returns true for insufficient quota/balance", () => {
    expect(isOutOfCreditError(new Error("Insufficient quota"))).toBe(true);
    expect(isOutOfCreditError(new Error("Insufficient credit balance"))).toBe(true);
  });

  it("returns true for add more tokens", () => {
    expect(isOutOfCreditError(new Error("Please add more tokens to continue"))).toBe(true);
  });

  it("returns false for rate limit without credit context", () => {
    expect(isOutOfCreditError(new Error("Rate limit exceeded"))).toBe(false);
  });
});

describe("classifyAgentApiError", () => {
  it("returns auth for invalid token errors", () => {
    expect(classifyAgentApiError(new Error("Invalid API key"))).toBe("auth");
    expect(classifyAgentApiError({ status: 401 })).toBe("auth");
  });

  it("returns out_of_credit for credit/quota errors", () => {
    expect(classifyAgentApiError(new Error("Out of credit"))).toBe("out_of_credit");
    expect(classifyAgentApiError(new Error("Add more tokens"))).toBe("out_of_credit");
  });

  it("returns rate_limit for rate limit errors", () => {
    expect(classifyAgentApiError(new Error("Rate limit exceeded"))).toBe("rate_limit");
    expect(classifyAgentApiError({ status: 429 })).toBe("rate_limit");
  });

  it("returns null for non-API errors", () => {
    expect(classifyAgentApiError(new Error("Connection timeout"))).toBe(null);
    expect(classifyAgentApiError(new Error("Something went wrong"))).toBe(null);
    expect(classifyAgentApiError(null)).toBe(null);
  });
});
