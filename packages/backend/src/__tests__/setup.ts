/**
 * Vitest setup file: mocks @google/genai so tests that transitively import agent-client
 * (via app, composition, agent.service, etc.) do not fail with "Failed to load url @google/genai".
 * The package has ESM resolution issues under Vite's transform; this mock is applied before
 * any test file loads.
 */
import { vi } from "vitest";

process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || "OpenSprint Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || "test@opensprint.dev";
process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL =
  process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL;

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: vi.fn().mockResolvedValue({
        candidates: [{ content: { parts: [{ text: "mock response" }] } }],
      }),
      generateContentStream: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          yield { candidates: [{ content: { parts: [{ text: "mock" }] } }] };
        },
      }),
    },
  })),
}));
