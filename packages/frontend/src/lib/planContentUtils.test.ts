import { describe, it, expect } from "vitest";
import { parsePlanContent, serializePlanContent } from "./planContentUtils";

describe("planContentUtils", () => {
  describe("parsePlanContent", () => {
    it("extracts title and body from markdown with # heading", () => {
      const content = "# Plan Phase - Feature Decomposition\n\n## Overview\n\nImplement the Plan phase.";
      const { title, body } = parsePlanContent(content);
      expect(title).toBe("Plan Phase - Feature Decomposition");
      expect(body).toBe("## Overview\n\nImplement the Plan phase.");
    });

    it("handles empty content", () => {
      const { title, body } = parsePlanContent("");
      expect(title).toBe("");
      expect(body).toBe("");
    });

    it("handles content without heading", () => {
      const content = "Just plain text\n\nMore text";
      const { title, body } = parsePlanContent(content);
      expect(title).toBe("Just plain text");
      expect(body).toBe("More text");
    });

    it("handles ## heading (uses first line as title)", () => {
      const content = "## Section\n\nBody";
      const { title, body } = parsePlanContent(content);
      expect(title).toBe("Section");
      expect(body).toBe("Body");
    });
  });

  describe("serializePlanContent", () => {
    it("combines title and body", () => {
      const result = serializePlanContent("My Plan", "## Overview\n\nContent");
      expect(result).toBe("# My Plan\n\n## Overview\n\nContent");
    });

    it("handles empty title", () => {
      const result = serializePlanContent("", "Body only");
      expect(result).toBe("Body only");
    });

    it("handles empty body", () => {
      const result = serializePlanContent("Title Only", "");
      expect(result).toBe("# Title Only");
    });

    it("handles both empty", () => {
      const result = serializePlanContent("", "");
      expect(result).toBe("");
    });
  });
});
