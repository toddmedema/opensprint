import { describe, it, expect, beforeEach } from "vitest";
import {
  filterAgentOutputChunk,
  resetAgentOutputFilter,
} from "./agentOutputFilter";

describe("agentOutputFilter", () => {
  beforeEach(() => {
    resetAgentOutputFilter();
  });

  describe("filterAgentOutputChunk", () => {
    it("passes through plain text unchanged", () => {
      expect(filterAgentOutputChunk("Hello world\n")).toBe("Hello world\n");
      expect(filterAgentOutputChunk("Some agent output")).toBe("Some agent output");
    });

    it("extracts text from Cursor stream-json type:text", () => {
      const chunk = '{"type":"text","text":"Hello from agent"}\n';
      expect(filterAgentOutputChunk(chunk)).toBe("Hello from agent");
    });

    it("extracts content from message_delta", () => {
      const chunk = '{"type":"message_delta","delta":{"content":"Thinking..."}}\n';
      expect(filterAgentOutputChunk(chunk)).toBe("Thinking...");
    });

    it("extracts text from content_block_delta", () => {
      const chunk = '{"type":"content_block_delta","delta":{"text":"Code here"}}\n';
      expect(filterAgentOutputChunk(chunk)).toBe("Code here");
    });

    it("extracts text from message content array", () => {
      const chunk =
        '{"type":"message","content":[{"type":"text","text":"Full response"}]}\n';
      expect(filterAgentOutputChunk(chunk)).toBe("Full response");
    });

    it("filters out metadata-only events (tool_use, etc)", () => {
      const chunk = '{"type":"tool_use","name":"edit","input":{}}\n';
      expect(filterAgentOutputChunk(chunk)).toBe("");
    });

    it("handles multiple NDJSON lines in one chunk", () => {
      const chunk =
        '{"type":"text","text":"Line 1"}\n{"type":"text","text":"Line 2"}\n';
      expect(filterAgentOutputChunk(chunk)).toBe("Line 1Line 2");
    });

    it("buffers incomplete JSON lines across chunks", () => {
      const part1 = '{"type":"text","text":"Hel';
      const part2 = 'lo"}\n';
      expect(filterAgentOutputChunk(part1)).toBe("");
      expect(filterAgentOutputChunk(part2)).toBe("Hello");
    });

    it("handles mixed plain text and JSON", () => {
      const chunk = "Starting...\n" + '{"type":"text","text":"JSON content"}\n';
      // "Starting...\n" is not valid JSON, so it passes through
      expect(filterAgentOutputChunk(chunk)).toContain("Starting...");
      expect(filterAgentOutputChunk(chunk)).toContain("JSON content");
    });

    it("handles empty chunk", () => {
      expect(filterAgentOutputChunk("")).toBe("");
    });

    it("resets buffer when resetAgentOutputFilter is called", () => {
      filterAgentOutputChunk('{"type":"text","text":"Par');
      resetAgentOutputFilter();
      // After reset, "tial" would form incomplete JSON - should not leak
      expect(filterAgentOutputChunk('tial"}\n')).toBe("Partial");
    });
  });

  describe("resetAgentOutputFilter", () => {
    it("clears buffer so next chunk starts fresh", () => {
      filterAgentOutputChunk('{"type":"text","text":"First"}\n');
      resetAgentOutputFilter();
      expect(filterAgentOutputChunk('{"type":"text","text":"Second"}\n')).toBe(
        "Second",
      );
    });
  });
});
