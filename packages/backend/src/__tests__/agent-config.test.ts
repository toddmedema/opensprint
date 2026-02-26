import { describe, it, expect } from "vitest";
import { parseAgentConfig } from "../schemas/agent-config.js";
import { AppError } from "../middleware/error-handler.js";

describe("agent-config schema", () => {
  describe("parseAgentConfig", () => {
    it("should accept valid simpleComplexityAgent config", () => {
      const config = parseAgentConfig(
        { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        "simpleComplexityAgent"
      );
      expect(config).toEqual({
        type: "claude",
        model: "claude-sonnet-4",
        cliCommand: null,
      });
    });

    it("should accept valid complexComplexityAgent config", () => {
      const config = parseAgentConfig(
        { type: "cursor", model: "composer-1.5", cliCommand: null },
        "complexComplexityAgent"
      );
      expect(config).toEqual({
        type: "cursor",
        model: "composer-1.5",
        cliCommand: null,
      });
    });

    it("should reject invalid type", () => {
      expect(() =>
        parseAgentConfig({ type: "invalid", model: null, cliCommand: null }, "simpleComplexityAgent")
      ).toThrow(AppError);
    });

    it("should reject invalid model type", () => {
      expect(() =>
        parseAgentConfig({ type: "claude", model: 123, cliCommand: null }, "complexComplexityAgent")
      ).toThrow(AppError);
    });
  });
});
