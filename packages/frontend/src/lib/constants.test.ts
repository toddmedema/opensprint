import { describe, it, expect } from "vitest";
import {
  CONTENT_CONTAINER_CLASS,
  GITHUB_REPO_URL,
  HOMEPAGE_CONTAINER_CLASS,
  MOBILE_BREAKPOINT,
  NAVBAR_HEIGHT,
  PHASE_TOOLBAR_BUTTON_SIZE,
  PHASE_TOOLBAR_HEIGHT,
  SETTINGS_HELP_CONTAINER_CLASS,
  TABLET_BREAKPOINT,
  PRD_SECTION_ORDER,
  PRD_SOURCE_COLORS,
  PRD_SOURCE_LABELS,
  getPrdSourceColor,
} from "./constants";

describe("constants", () => {
  describe("NAVBAR_HEIGHT", () => {
    it("is 48px for consistent navbar height across home and project pages", () => {
      expect(NAVBAR_HEIGHT).toBe(48);
    });
  });

  describe("PHASE_TOOLBAR_HEIGHT", () => {
    it("matches NAVBAR_HEIGHT for consistent second-level nav bar", () => {
      expect(PHASE_TOOLBAR_HEIGHT).toBe(NAVBAR_HEIGHT);
    });
  });

  describe("PHASE_TOOLBAR_BUTTON_SIZE", () => {
    it("is 32px for proportionally smaller buttons in phase toolbars", () => {
      expect(PHASE_TOOLBAR_BUTTON_SIZE).toBe(32);
    });
  });

  describe("MOBILE_BREAKPOINT", () => {
    it("is 768 to match Tailwind md breakpoint for JS-based responsive decisions", () => {
      expect(MOBILE_BREAKPOINT).toBe(768);
    });
  });

  describe("TABLET_BREAKPOINT", () => {
    it("is 1024 to match Tailwind lg breakpoint for JS-based responsive decisions", () => {
      expect(TABLET_BREAKPOINT).toBe(1024);
    });
  });

  describe("CONTENT_CONTAINER_CLASS", () => {
    it("includes max-w-3xl mx-auto px-6 for evaluate feedback alignment", () => {
      expect(CONTENT_CONTAINER_CLASS).toContain("max-w-3xl");
      expect(CONTENT_CONTAINER_CLASS).toContain("mx-auto");
      expect(CONTENT_CONTAINER_CLASS).toContain("px-6");
    });
  });

  describe("SETTINGS_HELP_CONTAINER_CLASS", () => {
    it("includes w-full max-w-[1440px] mx-auto px-6 for consistent Settings and Help page content width", () => {
      expect(SETTINGS_HELP_CONTAINER_CLASS).toContain("w-full");
      expect(SETTINGS_HELP_CONTAINER_CLASS).toContain("max-w-[1440px]");
      expect(SETTINGS_HELP_CONTAINER_CLASS).toContain("mx-auto");
      expect(SETTINGS_HELP_CONTAINER_CLASS).toContain("px-6");
    });
  });

  describe("HOMEPAGE_CONTAINER_CLASS", () => {
    it("includes max-w-[104rem] mx-auto px-6 for wider homepage header and cards", () => {
      expect(HOMEPAGE_CONTAINER_CLASS).toContain("max-w-[104rem]");
      expect(HOMEPAGE_CONTAINER_CLASS).toContain("mx-auto");
      expect(HOMEPAGE_CONTAINER_CLASS).toContain("px-6");
    });
  });

  describe("GITHUB_REPO_URL", () => {
    it("points to Open Sprint GitHub repository (opensprint, not opensprint.dev)", () => {
      expect(GITHUB_REPO_URL).toBe("https://github.com/toddmedema/opensprint");
      expect(GITHUB_REPO_URL).not.toContain("opensprint.dev");
    });
  });

  describe("PRD_SECTION_ORDER", () => {
    it("contains expected section keys in order", () => {
      expect(PRD_SECTION_ORDER[0]).toBe("executive_summary");
      expect(PRD_SECTION_ORDER).toContain("problem_statement");
      expect(PRD_SECTION_ORDER).toContain("open_questions");
      expect(PRD_SECTION_ORDER).toContain("assumptions_and_constraints");
      expect(PRD_SECTION_ORDER.indexOf("assumptions_and_constraints")).toBeLessThan(
        PRD_SECTION_ORDER.indexOf("technical_architecture")
      );
      expect(PRD_SECTION_ORDER.length).toBe(11);
    });
  });

  describe("PRD_SOURCE_LABELS", () => {
    it("maps sketch to Sketch for user-facing display", () => {
      expect(PRD_SOURCE_LABELS.sketch).toBe("Sketch");
      expect(PRD_SOURCE_LABELS.plan).toBe("Plan");
      expect(PRD_SOURCE_LABELS.execute).toBe("Execute");
      expect(PRD_SOURCE_LABELS.eval).toBe("Evaluate");
      expect(PRD_SOURCE_LABELS.deliver).toBe("Deliver");
    });
  });

  describe("PRD_SOURCE_COLORS", () => {
    it("has theme-aware colors for sketch, plan, execute, eval, deliver", () => {
      expect(PRD_SOURCE_COLORS.sketch).toContain("bg-theme-info-bg");
      expect(PRD_SOURCE_COLORS.plan).toContain("bg-theme-warning-bg");
      expect(PRD_SOURCE_COLORS.execute).toContain("bg-theme-success-bg");
      expect(PRD_SOURCE_COLORS.eval).toContain("bg-theme-feedback-feature-bg");
      expect(PRD_SOURCE_COLORS.deliver).toContain("bg-theme-surface-muted");
    });
  });

  describe("getPrdSourceColor", () => {
    it("returns same colors as PRD_SOURCE_COLORS for known source keys", () => {
      const sources = ["sketch", "plan", "execute", "eval", "deliver"] as const;
      for (const source of sources) {
        expect(getPrdSourceColor(source)).toBe(PRD_SOURCE_COLORS[source]);
      }
    });

    it("returns default purple for unknown sources", () => {
      expect(getPrdSourceColor("unknown")).toContain("bg-theme-feedback-feature-bg");
      expect(getPrdSourceColor("")).toContain("bg-theme-feedback-feature-bg");
    });
  });
});
