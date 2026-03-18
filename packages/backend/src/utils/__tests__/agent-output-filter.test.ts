import { describe, it, expect } from "vitest";
import { createAgentOutputFilter, filterAgentOutput } from "../agent-output-filter.js";

describe("agent-output-filter", () => {
  describe("createAgentOutputFilter", () => {
    it("returns an instance with filter and reset methods", () => {
      const f = createAgentOutputFilter();
      expect(typeof f.filter).toBe("function");
      expect(typeof f.reset).toBe("function");
    });

    it("passes through plain text unchanged", () => {
      const f = createAgentOutputFilter();
      expect(f.filter("Hello world\n")).toBe("Hello world\n");
    });

    it("filters out type tool_call NDJSON", () => {
      const f = createAgentOutputFilter();
      const chunk =
        '{"type":"text","text":"Before"}\n' +
        '{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{}}\n' +
        '{"type":"text","text":"After"}\n';
      expect(f.filter(chunk)).toBe("BeforeAfter");
    });

    it("filters out code-context entries (lineNumber/content/isContextLine)", () => {
      const f = createAgentOutputFilter();
      const chunk =
        '{"type":"text","text":"Visible"}\n' +
        '{"lineNumber":1,"content":"const x = 1;","isContextLine":true}\n' +
        '{"type":"text","text":"Done"}\n';
      expect(f.filter(chunk)).toBe("VisibleDone");
    });

    it("filters out lines containing onOutput", () => {
      const f = createAgentOutputFilter();
      const chunk =
        '{"type":"text","text":"OK"}\n' +
        '{"type":"message","content":"callback onOutput(chunk) was invoked"}\n' +
        '{"type":"text","text":"End"}\n';
      expect(f.filter(chunk)).toBe("OKEnd");
    });

    it("filters out lines containing ingestOutputChunk", () => {
      const f = createAgentOutputFilter();
      const chunk = "ingestOutputChunk(runState, chunk);\n";
      expect(f.filter(chunk)).toBe("");
    });

    it("extracts text from type text NDJSON", () => {
      const f = createAgentOutputFilter();
      expect(f.filter('{"type":"text","text":"Hello from agent"}\n')).toBe("Hello from agent");
    });

    it("filters out metadata-only events (tool_use)", () => {
      const f = createAgentOutputFilter();
      expect(f.filter('{"type":"tool_use","name":"edit","input":{}}\n')).toBe("");
    });
  });

  describe("filterAgentOutput", () => {
    it("filters full NDJSON in one pass", () => {
      const raw = '{"type":"text","text":"Hello"}\n{"type":"text","text":" world"}\n';
      expect(filterAgentOutput(raw)).toBe("Hello world");
    });

    it("filters out tool_call and code-context in one pass", () => {
      const raw =
        '{"type":"text","text":"Start"}\n' +
        '{"type":"tool_call","subtype":"started","call_id":"x"}\n' +
        '{"lineNumber":10,"content":"code","isContextLine":true}\n' +
        '{"type":"text","text":"End"}\n';
      expect(filterAgentOutput(raw)).toBe("StartEnd");
    });

    it("returns empty string for empty input", () => {
      expect(filterAgentOutput("")).toBe("");
    });

    it("passes through plain text unchanged", () => {
      const raw = "Plain text output\nNo JSON here\n";
      expect(filterAgentOutput(raw)).toBe("Plain text output\nNo JSON here\n");
    });
  });
});
