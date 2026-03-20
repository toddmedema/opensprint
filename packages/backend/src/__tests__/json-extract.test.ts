import { describe, it, expect } from "vitest";
import {
  extractJsonFromAgentResponse,
  extractJsonArrayFromAgentResponse,
} from "../utils/json-extract.js";

describe("extractJsonFromAgentResponse", () => {
  describe("with requiredKey", () => {
    it("extracts and parses JSON containing the required key", () => {
      const content = `Here is my response:
\`\`\`json
{"status":"success","tasks":[{"title":"Fix bug"}]}
\`\`\``;
      const result = extractJsonFromAgentResponse<{ status: string; tasks: unknown[] }>(
        content,
        "tasks"
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe("success");
      expect(result!.tasks).toHaveLength(1);
      expect(result!.tasks[0]).toEqual({ title: "Fix bug" });
    });

    it("returns null when required key is not present", () => {
      const content = 'Some text {"foo":"bar","baz":1} more text';
      const result = extractJsonFromAgentResponse<{ foo: string }>(content, "status");
      expect(result).toBeNull();
    });

    it("returns null when no JSON object exists", () => {
      const content = "No JSON here, just plain text";
      const result = extractJsonFromAgentResponse<{ x: number }>(content, "x");
      expect(result).toBeNull();
    });

    it("returns null when JSON is malformed", () => {
      const content = 'Here is invalid JSON: {"status":"success" invalid}';
      const result = extractJsonFromAgentResponse<{ status: string }>(content, "status");
      expect(result).toBeNull();
    });

    it("extracts nested object containing the key", () => {
      const content = 'Prefix {"outer":{"status":"ok","nested":true}} suffix';
      const result = extractJsonFromAgentResponse<{ outer: { status: string } }>(content, "status");
      expect(result).not.toBeNull();
      expect(result!.outer.status).toBe("ok");
    });

    it("extracts JSON inside fenced code blocks with surrounding prose", () => {
      const content = `I drafted the plan below.

\`\`\`json
{"title":"Volunteer Signup Form","content":"# Volunteer Signup Form\\n\\n## Overview\\nCollect volunteer details.","complexity":"medium","mockups":[{"title":"Form","content":"+------+"}]}
\`\`\`

Let me know if you want changes.`;
      const result = extractJsonFromAgentResponse<{ title: string }>(content, "title");
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Volunteer Signup Form");
    });

    it("returns the later valid candidate when an earlier candidate is malformed", () => {
      const content =
        'Prefix {"title":"broken","content":"oops" trailing} middle {"title":"Valid","content":"# Valid","complexity":"low","mockups":[{"title":"M","content":"x"}]} suffix';
      const result = extractJsonFromAgentResponse<{ title: string }>(content, "title");
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Valid");
    });

    it("skips JSON objects without the required key and returns a later matching object", () => {
      const content =
        'Before {"status":"thinking"} after {"open_questions":[{"id":"q1","text":"Need more detail"}]}';
      const result = extractJsonFromAgentResponse<{ open_questions: Array<{ text: string }> }>(
        content,
        "open_questions"
      );
      expect(result).not.toBeNull();
      expect(result!.open_questions[0]!.text).toContain("Need more detail");
    });
  });

  describe("without requiredKey", () => {
    it("extracts first JSON object in content", () => {
      const content = 'Before {"a":1,"b":2} after';
      const result = extractJsonFromAgentResponse<{ a: number; b: number }>(content);
      expect(result).not.toBeNull();
      expect(result!.a).toBe(1);
      expect(result!.b).toBe(2);
    });

    it("returns null when no JSON object exists", () => {
      const content = "No JSON here";
      const result = extractJsonFromAgentResponse<Record<string, unknown>>(content);
      expect(result).toBeNull();
    });

    it("returns null when JSON is malformed", () => {
      const content = 'Text {"broken": json} more';
      const result = extractJsonFromAgentResponse<{ broken: string }>(content);
      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(extractJsonFromAgentResponse<object>("")).toBeNull();
      expect(extractJsonFromAgentResponse<object>("", "key")).toBeNull();
    });

    it("handles JSON with escaped quotes in values", () => {
      const content = '{"status":"success","msg":"Say \\"hello\\""}';
      const result = extractJsonFromAgentResponse<{ status: string; msg: string }>(
        content,
        "status"
      );
      expect(result).not.toBeNull();
      expect(result!.msg).toBe('Say "hello"');
    });

    it("handles whitespace around JSON", () => {
      const content = '\n  \n  {"x": 42}  \n';
      const result = extractJsonFromAgentResponse<{ x: number }>(content, "x");
      expect(result).not.toBeNull();
      expect(result!.x).toBe(42);
    });

    it("recovers JSON-like output when string values contain raw newlines", () => {
      const content = `\`\`\`json
{
  "title": "Self-Improvement Code Review Setting",
  "content": "# Self-Improvement Code Review Setting

## Overview
Raise review quality with stricter defaults.",
  "complexity": "medium",
  "mockups": [{ "title": "Settings", "content": "+-----------------+" }]
}
\`\`\``;
      const result = extractJsonFromAgentResponse<{ title: string; content: string }>(
        content,
        "title"
      );
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Self-Improvement Code Review Setting");
      expect(result!.content).toContain("## Overview");
      expect(result!.content).toContain("stricter defaults");
    });

    it("ignores braces inside JSON string values", () => {
      const content =
        '{"title":"Feature","content":"# Heading\\n\\nExample payload: {\\\\\\"ok\\\\\\":true}\\n\\n## Acceptance Criteria\\n- done","complexity":"medium","mockups":[{"title":"Wireframe","content":"{ box }"}]}';
      const result = extractJsonFromAgentResponse<{ content: string }>(content, "title");
      expect(result).not.toBeNull();
      expect(result!.content).toContain('{\\"ok\\":true}');
    });

    it("handles escaped quotes and backslashes inside content", () => {
      const content =
        '{"title":"Feature","content":"Path C:\\\\\\\\temp\\\\\\\\app and note \\\\\\"quoted\\\\\\" text","complexity":"medium","mockups":[{"title":"M","content":"line"}]}';
      const result = extractJsonFromAgentResponse<{ content: string }>(content, "title");
      expect(result).not.toBeNull();
      expect(result!.content).toContain("C:\\\\temp\\\\app");
      expect(result!.content).toContain('\\"quoted\\"');
    });

    it("handles large markdown content with many headings and punctuation", () => {
      const content = `Summary first.

\`\`\`json
{
  "title": "Large Plan",
  "content": "# Large Plan\\n\\n## Overview\\nDetailed text.\\n\\n## Assumptions\\nNone beyond PRD.\\n\\n## Acceptance Criteria\\n1. Keep punctuation: commas, braces {like this}, and colons: yes.\\n\\n## Technical Approach\\nUse parser improvements.\\n\\n## Dependencies\\nNone.\\n\\n## Data Model Changes\\nNone.\\n\\n## API Specification\\nPOST /foo\\n\\n## UI/UX Requirements\\nShow a form.\\n\\n## Edge Cases and Error Handling\\nGracefully handle malformed JSON.\\n\\n## Testing Strategy\\nAdd regression coverage.\\n\\n## Estimated Complexity\\nmedium",
  "complexity": "medium",
  "mockups": [{"title":"Main","content":"+----------------+"}]
}
\`\`\``;
      const result = extractJsonFromAgentResponse<{ title: string; content: string }>(
        content,
        "title"
      );
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Large Plan");
      expect(result!.content).toContain("## Testing Strategy");
    });
  });
});

describe("extractJsonArrayFromAgentResponse", () => {
  it("extracts JSON array with leading text (e.g. enrichment agent response)", () => {
    const content = `Here are the items with priority and complexity:
[{"title":"Add tests","priority":1,"complexity":3},{"title":"Refactor API","priority":0,"complexity":7}]`;
    const result =
      extractJsonArrayFromAgentResponse<
        Array<{ title: string; priority: number; complexity: number }>
      >(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ title: "Add tests", priority: 1, complexity: 3 });
    expect(result![1]).toEqual({ title: "Refactor API", priority: 0, complexity: 7 });
  });

  it("extracts bare JSON array", () => {
    const content = '[{"title":"A","priority":1}]';
    const result =
      extractJsonArrayFromAgentResponse<Array<{ title: string; priority: number }>>(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({ title: "A", priority: 1 });
  });

  it("returns null when no JSON array exists", () => {
    const content = "No JSON array here, just plain text";
    const result = extractJsonArrayFromAgentResponse<unknown[]>(content);
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJsonArrayFromAgentResponse<unknown[]>("")).toBeNull();
  });

  it("extracts first array when multiple arrays exist", () => {
    const content = 'Before [{"x":1}] after [{"y":2}]';
    const result = extractJsonArrayFromAgentResponse<Array<{ x?: number; y?: number }>>(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({ x: 1 });
  });

  it("returns null when array is malformed", () => {
    const content = 'Here [{"title":"A" invalid}]';
    const result = extractJsonArrayFromAgentResponse<Array<{ title: string }>>(content);
    expect(result).toBeNull();
  });
});
