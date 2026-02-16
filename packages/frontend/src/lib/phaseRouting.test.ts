import { describe, it, expect } from "vitest";
import { phaseFromSlug, isValidPhaseSlug, getProjectPhasePath, VALID_PHASES } from "./phaseRouting";

describe("phaseRouting", () => {
  describe("phaseFromSlug", () => {
    it("returns dream for undefined slug", () => {
      expect(phaseFromSlug(undefined)).toBe("dream");
    });

    it("returns dream for empty string", () => {
      expect(phaseFromSlug("")).toBe("dream");
    });

    it("returns phase for valid slugs", () => {
      expect(phaseFromSlug("dream")).toBe("dream");
      expect(phaseFromSlug("plan")).toBe("plan");
      expect(phaseFromSlug("build")).toBe("build");
      expect(phaseFromSlug("verify")).toBe("verify");
    });

    it("returns dream for invalid slugs", () => {
      expect(phaseFromSlug("invalid")).toBe("dream");
      expect(phaseFromSlug("design")).toBe("dream");
      expect(phaseFromSlug("validate")).toBe("dream");
    });
  });

  describe("isValidPhaseSlug", () => {
    it("returns false for undefined", () => {
      expect(isValidPhaseSlug(undefined)).toBe(false);
    });

    it("returns false for invalid slugs", () => {
      expect(isValidPhaseSlug("")).toBe(false);
      expect(isValidPhaseSlug("invalid")).toBe(false);
    });

    it("returns true for valid slugs", () => {
      expect(isValidPhaseSlug("dream")).toBe(true);
      expect(isValidPhaseSlug("plan")).toBe(true);
      expect(isValidPhaseSlug("build")).toBe(true);
      expect(isValidPhaseSlug("verify")).toBe(true);
    });
  });

  describe("getProjectPhasePath", () => {
    it("builds path with explicit phase for all phases", () => {
      expect(getProjectPhasePath("proj-123", "dream")).toBe("/projects/proj-123/dream");
      expect(getProjectPhasePath("proj-123", "plan")).toBe("/projects/proj-123/plan");
      expect(getProjectPhasePath("proj-123", "build")).toBe("/projects/proj-123/build");
      expect(getProjectPhasePath("proj-123", "verify")).toBe("/projects/proj-123/verify");
    });

    it("handles different project IDs", () => {
      expect(getProjectPhasePath("abc", "dream")).toBe("/projects/abc/dream");
      expect(getProjectPhasePath("uuid-xyz-789", "build")).toBe("/projects/uuid-xyz-789/build");
    });
  });

  describe("VALID_PHASES", () => {
    it("contains all four phases in order", () => {
      expect(VALID_PHASES).toEqual(["dream", "plan", "build", "verify"]);
    });
  });
});
