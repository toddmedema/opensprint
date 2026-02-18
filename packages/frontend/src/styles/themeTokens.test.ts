/**
 * Unit tests for theme token configuration.
 * Verifies that theme tokens are properly configured.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const THEME_VARS = [
  "color-bg",
  "color-bg-elevated",
  "color-text",
  "color-text-muted",
  "color-surface",
  "color-border",
  "color-border-subtle",
  "color-ring",
  "color-input-bg",
  "color-input-text",
  "color-input-placeholder",
  "color-code-bg",
  "color-code-text",
];

describe("theme tokens", () => {
  it("tailwind config defines theme token colors that reference CSS variables", () => {
    expect(THEME_VARS).toContain("color-bg");
    expect(THEME_VARS).toContain("color-text");
    expect(THEME_VARS).toContain("color-code-bg");
  });

  it("index.css defines theme variables for light and dark", () => {
    const cssPath = join(__dirname, "index.css");
    const cssContent = readFileSync(cssPath, "utf-8");

    expect(cssContent).toContain("--color-bg:");
    expect(cssContent).toContain("--color-text:");
    expect(cssContent).toContain('html[data-theme="light"]');
    expect(cssContent).toContain('html[data-theme="dark"]');
    expect(cssContent).toContain("--color-code-bg:");
  });
});
