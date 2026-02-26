import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadFeedbackFormDraft,
  saveFeedbackFormDraft,
  clearFeedbackFormDraft,
  FEEDBACK_FORM_DRAFT_KEY_PREFIX,
  MAX_STORED_IMAGES_BYTES,
} from "./feedbackFormStorage";

describe("feedbackFormStorage", () => {
  const storage: Record<string, string> = {};

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
      length: 0,
      key: () => null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("loadFeedbackFormDraft", () => {
    it("returns empty draft when nothing stored", () => {
      expect(loadFeedbackFormDraft("proj-1")).toEqual({
        text: "",
        images: [],
        priority: null,
      });
    });

    it("restores text, images, and priority from storage", () => {
      const draft = {
        text: "Bug in login flow",
        images: ["data:image/png;base64,iVBORw0KGgo="],
        priority: 0,
      };
      storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`] = JSON.stringify(draft);
      expect(loadFeedbackFormDraft("proj-1")).toEqual(draft);
    });

    it("uses project-specific keys", () => {
      storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`] = JSON.stringify({
        text: "Proj 1 feedback",
        images: [],
        priority: null,
      });
      storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-2`] = JSON.stringify({
        text: "Proj 2 feedback",
        images: [],
        priority: 2,
      });
      expect(loadFeedbackFormDraft("proj-1").text).toBe("Proj 1 feedback");
      expect(loadFeedbackFormDraft("proj-2").text).toBe("Proj 2 feedback");
      expect(loadFeedbackFormDraft("proj-2").priority).toBe(2);
    });

    it("returns empty draft for invalid JSON", () => {
      storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`] = "invalid json";
      expect(loadFeedbackFormDraft("proj-1")).toEqual({
        text: "",
        images: [],
        priority: null,
      });
    });

    it("filters invalid images (non-data URLs)", () => {
      storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`] = JSON.stringify({
        text: "Test",
        images: ["data:image/png;base64,abc", "http://invalid.com/img.png", "not-a-url"],
        priority: null,
      });
      const result = loadFeedbackFormDraft("proj-1");
      expect(result.images).toEqual(["data:image/png;base64,abc"]);
    });

    it("validates priority range (0-4)", () => {
      storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`] = JSON.stringify({
        text: "Test",
        images: [],
        priority: 5,
      });
      expect(loadFeedbackFormDraft("proj-1").priority).toBeNull();

      storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`] = JSON.stringify({
        text: "Test",
        images: [],
        priority: 2,
      });
      expect(loadFeedbackFormDraft("proj-1").priority).toBe(2);
    });
  });

  describe("saveFeedbackFormDraft", () => {
    it("persists draft to localStorage", () => {
      saveFeedbackFormDraft("proj-1", {
        text: "New feedback",
        images: [],
        priority: 1,
      });
      const stored = JSON.parse(storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`]);
      expect(stored).toEqual({ text: "New feedback", images: [], priority: 1 });
    });

    it("truncates images when total size exceeds limit", () => {
      const bigImage = "data:image/png;base64," + "x".repeat(MAX_STORED_IMAGES_BYTES);
      saveFeedbackFormDraft("proj-1", {
        text: "Test",
        images: [bigImage],
        priority: null,
      });
      const stored = JSON.parse(storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`]);
      expect(stored.images.length).toBe(0);
    });

    it("saves valid images within size limit", () => {
      const smallImage = "data:image/png;base64,iVBORw0KGgo=";
      saveFeedbackFormDraft("proj-1", {
        text: "With image",
        images: [smallImage],
        priority: null,
      });
      const stored = JSON.parse(storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`]);
      expect(stored.images).toEqual([smallImage]);
    });
  });

  describe("clearFeedbackFormDraft", () => {
    it("removes draft from localStorage", () => {
      storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`] = JSON.stringify({
        text: "Old",
        images: [],
        priority: null,
      });
      clearFeedbackFormDraft("proj-1");
      expect(storage[`${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`]).toBeUndefined();
    });

    it("is idempotent (no error when key missing)", () => {
      expect(() => clearFeedbackFormDraft("proj-nonexistent")).not.toThrow();
    });
  });
});
