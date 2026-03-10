import { describe, it, expect } from "vitest";
import { getKeyboardShortcuts } from "./keybindings";

describe("keybindings", () => {

  it("getKeyboardShortcuts returns all app shortcuts with action and keys", () => {
    const shortcuts = getKeyboardShortcuts();
    expect(shortcuts.length).toBeGreaterThanOrEqual(8);
    expect(shortcuts.every((s) => typeof s.action === "string" && typeof s.keys === "string")).toBe(
      true
    );
    const actions = shortcuts.map((s) => s.action);
    expect(actions).toContain("Go to Sketch");
    expect(actions).toContain("Go to Plan");
    expect(actions).toContain("Open Help");
    expect(actions).toContain("Open Settings");
    expect(actions).toContain("Go to Home");
    expect(actions).toContain("Submit message");
  });

  it("phase shortcuts have context When in a project", () => {
    const shortcuts = getKeyboardShortcuts();
    const phaseShortcuts = shortcuts.filter(
      (s) =>
        s.action.startsWith("Go to ") &&
        ["Sketch", "Plan", "Execute", "Evaluate", "Deliver"].some((p) => s.action.endsWith(p))
    );
    expect(phaseShortcuts.length).toBe(5);
    expect(phaseShortcuts.every((s) => s.context === "When in a project")).toBe(true);
  });

  it("submit message shortcut keys are platform-aware", () => {
    const shortcuts = getKeyboardShortcuts();
    const submit = shortcuts.find((s) => s.action === "Submit message");
    expect(submit).toBeDefined();
    expect(submit!.keys).toMatch(/Enter.*submit/);
    expect(submit!.keys).toMatch(/Shift\+Enter/);
  });
});
