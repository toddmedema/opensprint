// @vitest-environment node
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import tailwind from "tailwindcss";
import { readFileSync } from "node:fs";
import config from "../../tailwind.config.js";

describe("compiled semantic utilities", () => {
  it("emits base, opacity and accent focus rules and a fenced-code override", async () => {
    const result = await postcss([
      tailwind({
        ...config,
        content: [
          {
            raw: "prose prose-task-description bg-theme-bg bg-theme-bg/90 hover:bg-theme-info-bg/50 text-theme-accent focus:ring-theme-accent text-accent-primary",
          },
        ],
      }),
    ]).process(readFileSync(new URL("./index.css", import.meta.url), "utf8"), { from: undefined });
    const declarations = (selector: string) => {
      const values: string[] = [];
      result.root.walkRules((rule) => {
        if (rule.selector === selector)
          rule.walkDecls((decl) => {
            values.push(`${decl.prop}:${decl.value}${decl.important ? "!important" : ""}`);
          });
      });
      return values.join(";");
    };
    expect(declarations(".bg-theme-bg")).toContain("var(--ui-surface-page)");
    expect(declarations(".bg-theme-bg\\/90")).toContain(
      "color-mix(in srgb, var(--ui-surface-page) calc(0.9 * 100%), transparent)"
    );
    expect(declarations(".hover\\:bg-theme-info-bg\\/50:hover")).toContain("calc(0.5 * 100%)");
    expect(declarations(".text-theme-accent")).toContain("var(--ui-accent-primary)");
    expect(declarations(".focus\\:ring-theme-accent:focus")).toContain("var(--ui-accent-primary)");
    expect(result.css).toMatch(
      /html\[data-theme\] \.prose-task-description pre > code\s*\{\s*color: var\(--ui-text-code\) !important/
    );

    const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
    const darkStart = css.indexOf('html[data-theme="dark"]');
    for (const theme of [css.slice(0, darkStart), css.slice(darkStart)]) {
      const token = (name: string) => theme.match(new RegExp(`${name}:\\s*(#[a-fA-F0-9]{6})`))![1];
      const luminance = (hex: string) => {
        const rgb = [1, 3, 5]
          .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const ratio = (a: string, b: string) => {
        const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      expect(ratio(token("--ui-text-code"), token("--ui-surface-code"))).toBeGreaterThanOrEqual(
        4.5
      );
      expect(
        ratio(token("--ui-text-primary"), token("--ui-surface-raised"))
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
