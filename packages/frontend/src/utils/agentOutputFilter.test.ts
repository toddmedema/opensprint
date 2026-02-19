import { describe, it, expect, beforeEach } from "vitest";
import { createAgentOutputFilter, type AgentOutputFilter } from "./agentOutputFilter";

describe("agentOutputFilter", () => {
  let filter: AgentOutputFilter;

  beforeEach(() => {
    filter = createAgentOutputFilter();
  });

  describe("filter", () => {
    it("passes through plain text unchanged", () => {
      expect(filter.filter("Hello world\n")).toBe("Hello world\n");
    });

    it("buffers plain text without trailing newline", () => {
      expect(filter.filter("Some agent output")).toBe("");
      expect(filter.filter("\n")).toBe("Some agent output\n");
    });

    it("extracts text from Cursor stream-json type:text", () => {
      const chunk = '{"type":"text","text":"Hello from agent"}\n';
      expect(filter.filter(chunk)).toBe("Hello from agent");
    });

    it("extracts content from message_delta", () => {
      const chunk = '{"type":"message_delta","delta":{"content":"Thinking..."}}\n';
      expect(filter.filter(chunk)).toBe("Thinking...");
    });

    it("extracts text from content_block_delta", () => {
      const chunk = '{"type":"content_block_delta","delta":{"text":"Code here"}}\n';
      expect(filter.filter(chunk)).toBe("Code here");
    });

    it("extracts text from message content array", () => {
      const chunk = '{"type":"message","content":[{"type":"text","text":"Full response"}]}\n';
      expect(filter.filter(chunk)).toBe("Full response");
    });

    it("filters out metadata-only events (tool_use, etc)", () => {
      const chunk = '{"type":"tool_use","name":"edit","input":{}}\n';
      expect(filter.filter(chunk)).toBe("");
    });

    it("handles multiple NDJSON lines in one chunk", () => {
      const chunk = '{"type":"text","text":"Line 1"}\n{"type":"text","text":"Line 2"}\n';
      expect(filter.filter(chunk)).toBe("Line 1Line 2");
    });

    it("buffers incomplete JSON lines across chunks", () => {
      const part1 = '{"type":"text","text":"Hel';
      const part2 = 'lo"}\n';
      expect(filter.filter(part1)).toBe("");
      expect(filter.filter(part2)).toBe("Hello");
    });

    it("handles mixed plain text and JSON", () => {
      const chunk = "Starting...\n" + '{"type":"text","text":"JSON content"}\n';
      // "Starting...\n" is not valid JSON, so it passes through
      expect(filter.filter(chunk)).toContain("Starting...");
      expect(filter.filter(chunk)).toContain("JSON content");
    });

    it("handles empty chunk", () => {
      expect(filter.filter("")).toBe("");
    });

    it("resets buffer when reset() is called", () => {
      filter.filter('{"type":"text","text":"Par');
      filter.reset();
      // After reset, buffer is empty; 'tial"}' is invalid JSON, so it passes through as plain text
      expect(filter.filter('tial"}\n')).toBe('tial"}\n');
    });
  });

  describe("reset", () => {
    it("clears buffer so next chunk starts fresh", () => {
      filter.filter('{"type":"text","text":"First"}\n');
      filter.reset();
      expect(filter.filter('{"type":"text","text":"Second"}\n')).toBe("Second");
    });
  });

  describe("factory isolation", () => {
    it("creates independent instances with separate buffers", () => {
      const filter1 = createAgentOutputFilter();
      const filter2 = createAgentOutputFilter();

      filter1.filter('{"type":"text","text":"Hel');
      filter2.filter('{"type":"text","text":"Wor');

      expect(filter1.filter('lo"}\n')).toBe("Hello");
      expect(filter2.filter('ld"}\n')).toBe("World");
    });

    it("resetting one instance does not affect another", () => {
      const filter1 = createAgentOutputFilter();
      const filter2 = createAgentOutputFilter();

      filter1.filter('{"type":"text","text":"Par');
      filter2.filter('{"type":"text","text":"Par');

      filter1.reset();

      expect(filter1.filter('tial"}\n')).toBe('tial"}\n');
      expect(filter2.filter('tial"}\n')).toBe("Partial");
    });
  });
});
