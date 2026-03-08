import { describe, expect, it } from "vitest";
import { AppError } from "../middleware/error-handler.js";
import { parseAgentConfig } from "../schemas/agent-config.js";

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

    it("should accept openai agent type", () => {
      const config = parseAgentConfig(
        { type: "openai", model: "gpt-4o", cliCommand: null },
        "simpleComplexityAgent"
      );
      expect(config).toEqual({
        type: "openai",
        model: "gpt-4o",
        cliCommand: null,
      });
    });

    it("should accept google agent type", () => {
      const config = parseAgentConfig(
        { type: "google", model: "gemini-2.5-pro", cliCommand: null },
        "simpleComplexityAgent"
      );
      expect(config).toEqual({
        type: "google",
        model: "gemini-2.5-pro",
        cliCommand: null,
      });
    });

    it("should reject invalid type", () => {
      expect(() =>
        parseAgentConfig(
          { type: "invalid", model: null, cliCommand: null },
          "simpleComplexityAgent"
        )
      ).toThrow(AppError);
    });

    it("should reject invalid model type", () => {
      expect(() =>
        parseAgentConfig({ type: "claude", model: 123, cliCommand: null }, "complexComplexityAgent")
      ).toThrow(AppError);
    });

    it("should accept lmstudio agent type with baseUrl", () => {
      const config = parseAgentConfig(
        { type: "lmstudio", model: "local-model", cliCommand: null, baseUrl: "http://localhost:1234" },
        "simpleComplexityAgent"
      );
      expect(config).toEqual({
        type: "lmstudio",
        model: "local-model",
        cliCommand: null,
        baseUrl: "http://localhost:1234",
      });
    });

    it("should accept lmstudio without baseUrl (optional)", () => {
      const config = parseAgentConfig(
        { type: "lmstudio", model: "local-model", cliCommand: null },
        "simpleComplexityAgent"
      );
      expect(config).toEqual({
        type: "lmstudio",
        model: "local-model",
        cliCommand: null,
        baseUrl: undefined,
      });
    });

    it("should normalize baseUrl trailing slash", () => {
      const config = parseAgentConfig(
        {
          type: "lmstudio",
          model: "local-model",
          cliCommand: null,
          baseUrl: "https://localhost:1234/",
        },
        "simpleComplexityAgent"
      );
      expect(config.baseUrl).toBe("https://localhost:1234");
    });

    it("should reject non-http(s) baseUrl with clear message", () => {
      expect(() =>
        parseAgentConfig(
          {
            type: "lmstudio",
            model: "local-model",
            cliCommand: null,
            baseUrl: "ftp://localhost:1234",
          },
          "simpleComplexityAgent"
        )
      ).toThrow(AppError);
      try {
        parseAgentConfig(
          {
            type: "lmstudio",
            model: "local-model",
            cliCommand: null,
            baseUrl: "ftp://localhost:1234",
          },
          "simpleComplexityAgent"
        );
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).message).toContain("baseUrl must be an http or https URL");
      }
    });

    it("should reject invalid baseUrl (non-URL string)", () => {
      expect(() =>
        parseAgentConfig(
          {
            type: "lmstudio",
            model: "local-model",
            cliCommand: null,
            baseUrl: "not-a-url",
          },
          "simpleComplexityAgent"
        )
      ).toThrow(AppError);
      try {
        parseAgentConfig(
          {
            type: "lmstudio",
            model: "local-model",
            cliCommand: null,
            baseUrl: "not-a-url",
          },
          "simpleComplexityAgent"
        );
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).message).toContain("baseUrl must be an http or https URL");
      }
    });

    it("should reject empty baseUrl when type is lmstudio with clear message", () => {
      expect(() =>
        parseAgentConfig(
          { type: "lmstudio", model: "local-model", cliCommand: null, baseUrl: "   " },
          "simpleComplexityAgent"
        )
      ).toThrow(AppError);
      try {
        parseAgentConfig(
          { type: "lmstudio", model: "local-model", cliCommand: null, baseUrl: "   " },
          "simpleComplexityAgent"
        );
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).message).toContain("baseUrl cannot be empty when type is lmstudio");
      }
    });
  });
});
