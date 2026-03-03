import { describe, it, expect } from "vitest";
import { createAgentOutputFilter, filterAgentOutput } from "./agentOutputFilter";

describe("agentOutputFilter", () => {
  describe("createAgentOutputFilter", () => {
    it("returns an instance with filter and reset methods", () => {
      const f = createAgentOutputFilter();
      expect(typeof f.filter).toBe("function");
      expect(typeof f.reset).toBe("function");
    });

    it("passes through plain text unchanged", () => {
      const f = createAgentOutputFilter();
      expect(f.filter("Hello world\n")).toBe("Hello world\n");
      expect(f.filter("Some agent output\n")).toBe("Some agent output\n");
    });

    it("buffers plain text without trailing newline", () => {
      const f = createAgentOutputFilter();
      expect(f.filter("Some agent output")).toBe("");
      expect(f.filter("\n")).toBe("Some agent output\n");
    });

    it("extracts text from Cursor stream-json type:text", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"text","text":"Hello from agent"}\n';
      expect(f.filter(chunk)).toBe("Hello from agent");
    });

    it("extracts content from message_delta", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"message_delta","delta":{"content":"Hello"}}\n';
      expect(f.filter(chunk)).toBe("Hello");
    });

    it("extracts text from content_block_delta", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"content_block_delta","delta":{"text":"Code here"}}\n';
      expect(f.filter(chunk)).toBe("Code here");
    });

    it("extracts text from message content array", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"message","content":[{"type":"text","text":"Full response"}]}\n';
      expect(f.filter(chunk)).toBe("Full response");
    });

    it("extracts text from Cursor Composer type:assistant with message.content", () => {
      const f = createAgentOutputFilter();
      const chunk =
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will implement the fix."}]},"session_id":"abc","timestamp_ms":123}\n';
      expect(f.filter(chunk)).toBe("I will implement the fix.");
    });

    it("extracts newlines from Cursor Composer assistant messages", () => {
      const f = createAgentOutputFilter();
      const chunk =
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"\\n\\n"}]},"session_id":"abc"}\n';
      expect(f.filter(chunk)).toBe("\n\n");
    });

    it("extracts thinking from Cursor Composer type:thinking with text property", () => {
      const f = createAgentOutputFilter();
      const chunk =
        '{"type":"thinking","subtype":"delta","text":"analyzing the codebase","session_id":"abc"}\n';
      expect(f.filter(chunk)).toBe("analyzing the codebase\n");
    });

    it("skips Cursor Composer thinking delta with empty text", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"thinking","subtype":"delta","text":"","session_id":"abc"}\n';
      expect(f.filter(chunk)).toBe("");
    });

    it("filters out metadata-only events (tool_use, etc)", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"tool_use","name":"edit","input":{}}\n';
      expect(f.filter(chunk)).toBe("");
    });

    it("surfaces explicit error events as agent errors", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"error","message":"fatal: no rebase in progress"}\n';
      expect(f.filter(chunk)).toBe("[Agent error: fatal: no rebase in progress]\n");
    });

    it("extracts actual thinking text from type:thinking JSON", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"thinking","content":"internal reasoning..."}\n';
      expect(f.filter(chunk)).toBe("internal reasoning...\n");
    });

    it("extracts thinking across chunked stream (raw never flashes)", () => {
      const f = createAgentOutputFilter();
      const part1 = '{"type":"thinking","content":"';
      const part2 = "long thought";
      const part3 = '"}\n';
      expect(f.filter(part1)).toBe("");
      expect(f.filter(part2)).toBe("");
      expect(f.filter(part3)).toBe("long thought\n");
    });

    it("handles thinking mixed with other output", () => {
      const f = createAgentOutputFilter();
      const chunk =
        '{"type":"text","text":"Before"}\n{"type":"thinking","content":"..."}\n{"type":"text","text":"After"}\n';
      expect(f.filter(chunk)).toBe("Before...\nAfter");
    });

    it("hides type:thinking with no content (minimal JSON)", () => {
      const f = createAgentOutputFilter();
      expect(f.filter('{"type":"thinking"}\n')).toBe("");
    });

    it("extracts thinking from content_block_delta with delta.thinking", () => {
      const f = createAgentOutputFilter();
      const chunk =
        '{"type":"content_block_delta","delta":{"type":"thinking","thinking":"streamed thought"}}\n';
      expect(f.filter(chunk)).toBe("streamed thought");
    });

    it("extracts thinking from type:thinking with thinking property", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"thinking","thinking":"reasoning step"}\n';
      expect(f.filter(chunk)).toBe("reasoning step\n");
    });

    it("handles multiple NDJSON lines in one chunk", () => {
      const f = createAgentOutputFilter();
      const chunk = '{"type":"text","text":"Line 1"}\n{"type":"text","text":"Line 2"}\n';
      expect(f.filter(chunk)).toBe("Line 1Line 2");
    });

    it("buffers incomplete JSON lines across chunks", () => {
      const f = createAgentOutputFilter();
      const part1 = '{"type":"text","text":"Hel';
      const part2 = 'lo"}\n';
      expect(f.filter(part1)).toBe("");
      expect(f.filter(part2)).toBe("Hello");
    });

    it("handles mixed plain text and JSON", () => {
      const f = createAgentOutputFilter();
      const chunk = "Starting...\n" + '{"type":"text","text":"JSON content"}\n';
      // "Starting...\n" is not valid JSON, so it passes through
      expect(f.filter(chunk)).toContain("Starting...");
      expect(f.filter(chunk)).toContain("JSON content");
    });

    it("handles empty chunk", () => {
      const f = createAgentOutputFilter();
      expect(f.filter("")).toBe("");
    });

    it("resets buffer when reset is called", () => {
      const f = createAgentOutputFilter();
      f.filter('{"type":"text","text":"Par');
      f.reset();
      // After reset, buffer is empty; 'tial"}' is invalid JSON, so it passes through as plain text
      expect(f.filter('tial"}\n')).toBe('tial"}\n');
    });

    it("clears buffer so next chunk starts fresh after reset", () => {
      const f = createAgentOutputFilter();
      f.filter('{"type":"text","text":"First"}\n');
      f.reset();
      expect(f.filter('{"type":"text","text":"Second"}\n')).toBe("Second");
    });

    it("creates independent instances with separate buffers", () => {
      const f1 = createAgentOutputFilter();
      const f2 = createAgentOutputFilter();

      f1.filter('{"type":"text","text":"Hel');
      f2.filter('{"type":"text","text":"Wor');

      expect(f1.filter('lo"}\n')).toBe("Hello");
      expect(f2.filter('ld"}\n')).toBe("World");
    });

    it("resetting one instance does not affect another", () => {
      const f1 = createAgentOutputFilter();
      const f2 = createAgentOutputFilter();

      f1.filter('{"type":"text","text":"Par');
      f2.filter('{"type":"text","text":"Par');

      f1.reset();

      expect(f1.filter('tial"}\n')).toBe('tial"}\n');
      expect(f2.filter('tial"}\n')).toBe("Partial");
    });

    it("isolates buffer between instances", () => {
      const f1 = createAgentOutputFilter();
      const f2 = createAgentOutputFilter();
      f1.filter('{"type":"text","text":"Hel');
      f2.filter('lo"}\n');
      // f1 has incomplete buffer, f2 has complete line
      expect(f1.filter('lo"}\n')).toBe("Hello");
      expect(f2.filter('{"type":"text","text":"Other"}\n')).toBe("Other");
    });
  });

  describe("filterAgentOutput", () => {
    it("filters full NDJSON in one pass", () => {
      const raw = '{"type":"text","text":"Hello"}\n{"type":"text","text":" world"}\n';
      expect(filterAgentOutput(raw)).toBe("Hello world");
    });

    it("handles NDJSON without trailing newline", () => {
      const raw = '{"type":"text","text":"Last line"}';
      expect(filterAgentOutput(raw)).toBe("Last line");
    });

    it("passes through plain text unchanged", () => {
      const raw = "Plain text output\nNo JSON here\n";
      expect(filterAgentOutput(raw)).toBe("Plain text output\nNo JSON here\n");
    });

    it("filters out metadata events", () => {
      const raw =
        '{"type":"text","text":"Visible"}\n{"type":"tool_use","name":"edit"}\n{"type":"text","text":"Also visible"}\n';
      expect(filterAgentOutput(raw)).toBe("VisibleAlso visible");
    });

    it("extracts actual thinking text in full NDJSON", () => {
      const raw =
        '{"type":"text","text":"Start"}\n{"type":"thinking","content":"analyzing..."}\n{"type":"text","text":"Done"}\n';
      expect(filterAgentOutput(raw)).toBe("Startanalyzing...\nDone");
    });

    it("returns empty string for empty input", () => {
      expect(filterAgentOutput("")).toBe("");
    });

    it("extracts from Cursor Composer NDJSON (assistant + thinking)", () => {
      const raw =
        '{"type":"thinking","subtype":"delta","text":"checking filter"}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here is the fix."}]}}\n';
      expect(filterAgentOutput(raw)).toBe("checking filter\nHere is the fix.");
    });
  });
});
