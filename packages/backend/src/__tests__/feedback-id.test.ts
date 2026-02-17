import { describe, it, expect } from "vitest";
import { generateShortFeedbackId } from "../utils/feedback-id.js";

describe("generateShortFeedbackId", () => {
  const ID_REGEX = /^[a-z0-9]{8}$/;

  it("should return exactly 8 characters", () => {
    const id = generateShortFeedbackId();
    expect(id).toHaveLength(8);
  });

  it("should return only lowercase letters and digits", () => {
    const id = generateShortFeedbackId();
    expect(id).toMatch(ID_REGEX);
  });

  it("should produce unique IDs across many calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateShortFeedbackId());
    }
    expect(ids.size).toBe(1000);
  });

  it("should match alphanumeric pattern (a-z, 0-9)", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateShortFeedbackId();
      expect(id).toMatch(ID_REGEX);
      expect(id).not.toMatch(/[^a-z0-9]/);
    }
  });
});
