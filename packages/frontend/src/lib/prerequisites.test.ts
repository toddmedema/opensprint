import { describe, it, expect } from "vitest";
import { PREREQ_ITEMS, getPrereqInstallUrl } from "./prerequisites";

describe("prerequisites", () => {
  describe("PREREQ_ITEMS", () => {
    it("has Git and Node.js in order", () => {
      expect(PREREQ_ITEMS).toEqual(["Git", "Node.js"]);
    });
  });

  describe("getPrereqInstallUrl", () => {
    it("returns nodejs.org for Node.js", () => {
      expect(getPrereqInstallUrl("Node.js")).toBe("https://nodejs.org/");
      expect(getPrereqInstallUrl("Node.js", "darwin")).toBe("https://nodejs.org/");
      expect(getPrereqInstallUrl("Node.js", "win32")).toBe("https://nodejs.org/");
    });

    it("returns git-scm.com for Git on non-win32", () => {
      expect(getPrereqInstallUrl("Git")).toBe("https://git-scm.com/");
      expect(getPrereqInstallUrl("Git", "darwin")).toBe("https://git-scm.com/");
      expect(getPrereqInstallUrl("Git", "linux")).toBe("https://git-scm.com/");
    });

    it("returns git-scm.com/download/win for Git on win32", () => {
      expect(getPrereqInstallUrl("Git", "win32")).toBe("https://git-scm.com/download/win");
    });

    it("returns # for unknown tool", () => {
      expect(getPrereqInstallUrl("Other")).toBe("#");
    });
  });
});
