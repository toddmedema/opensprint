import { describe, it, expect } from "vitest";
import { markdownToHtml, htmlToMarkdown } from "./markdownUtils";

describe("markdownUtils", () => {
  describe("markdownToHtml", () => {
    it("returns empty string for empty input", async () => {
      expect(await markdownToHtml("")).toBe("");
      expect(await markdownToHtml("   ")).toBe("");
    });

    it("converts markdown to HTML", async () => {
      const html = await markdownToHtml("**bold** and *italic*");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
    });

    it("converts headers", async () => {
      const html = await markdownToHtml("## Header");
      expect(html).toContain("<h2");
      expect(html).toContain("Header");
    });

    it("trims HTML output to avoid spurious blank space at top of rendered content", async () => {
      const html = await markdownToHtml("## Overview\n\nContent");
      expect(html).not.toMatch(/^\s/);
      expect(html).not.toMatch(/\s$/);
      expect(html).toContain("<h2");
      expect(html).toContain("Overview");
    });

    it("converts lists", async () => {
      const html = await markdownToHtml("- item 1\n- item 2");
      expect(html).toContain("<ul");
      expect(html).toContain("item 1");
      expect(html).toContain("item 2");
    });
  });

  describe("htmlToMarkdown", () => {
    it("returns empty string for empty input", () => {
      expect(htmlToMarkdown("")).toBe("");
      expect(htmlToMarkdown("   ")).toBe("");
    });

    it("converts HTML to markdown", () => {
      const md = htmlToMarkdown("<p><strong>bold</strong> and <em>italic</em></p>");
      expect(md).toContain("**bold**");
      expect(md).toContain("*italic*");
    });

    it("converts headers", () => {
      const md = htmlToMarkdown("<h2>Header</h2>");
      expect(md).toContain("##");
      expect(md).toContain("Header");
    });

    it("handles contenteditable output", () => {
      const md = htmlToMarkdown("<p>Hello <b>world</b></p>");
      expect(md).toContain("Hello");
      expect(md).toContain("world");
    });
  });

  describe("round-trip markdown", () => {
    it("preserves content through markdown -> html -> markdown cycle", async () => {
      const original = "**Bold** and *italic* with `code`";
      const html = await markdownToHtml(original);
      const roundTripped = htmlToMarkdown(html);
      expect(roundTripped).toContain("**");
      expect(roundTripped).toContain("Bold");
      expect(roundTripped).toContain("*");
      expect(roundTripped).toContain("italic");
      expect(roundTripped).toContain("code");
    });

    it("preserves lists through round-trip", async () => {
      const original = "- item 1\n- item 2\n- item 3";
      const html = await markdownToHtml(original);
      const roundTripped = htmlToMarkdown(html);
      expect(roundTripped).toContain("item 1");
      expect(roundTripped).toContain("item 2");
      expect(roundTripped).toContain("item 3");
    });

    it("preserves links through round-trip", async () => {
      const original = "See [OpenSprint](https://opensprint.dev) for more.";
      const html = await markdownToHtml(original);
      const roundTripped = htmlToMarkdown(html);
      expect(roundTripped).toContain("OpenSprint");
      expect(roundTripped).toContain("https://opensprint.dev");
    });

    it("preserves code blocks through round-trip", async () => {
      const original = "```js\nconst x = 1;\n```";
      const html = await markdownToHtml(original);
      const roundTripped = htmlToMarkdown(html);
      expect(roundTripped).toContain("const");
      expect(roundTripped).toContain("x = 1");
    });

    it("preserves nested formatting through round-trip", async () => {
      const original = "**Bold with *italic* inside**";
      const html = await markdownToHtml(original);
      const roundTripped = htmlToMarkdown(html);
      expect(roundTripped).toContain("Bold");
      expect(roundTripped).toContain("italic");
    });
  });
});
