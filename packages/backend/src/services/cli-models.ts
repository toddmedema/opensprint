import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildNativeCliEnv, resolveNativeCliCommand } from "../utils/native-cli.js";

const execFileAsync = promisify(execFile);
type ModelOption = { id: string; displayName: string };

// Claude's supported aliases track new versions without requiring API credentials.
// https://code.claude.com/docs/en/model-config
export const CLAUDE_CLI_MODELS: ModelOption[] = [
  { id: "default", displayName: "Claude Code default" },
  { id: "sonnet", displayName: "Claude Sonnet (latest)" },
  { id: "opus", displayName: "Claude Opus (latest)" },
  { id: "haiku", displayName: "Claude Haiku (latest)" },
  { id: "fable", displayName: "Claude Fable (latest; usage credits may apply)" },
];

export function parseCodexModelCatalog(raw: unknown): ModelOption[] {
  const body = raw as { models?: unknown[]; data?: unknown[] };
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray(body?.models)
      ? body.models
      : Array.isArray(body?.data)
        ? body.data
        : [];
  const seen = new Set<string>();
  return entries
    .filter((value): value is Record<string, unknown> => !!value && typeof value === "object")
    .filter((entry) => entry.hidden !== true && entry.visibility !== "hide")
    .sort((a, b) => Number(a.priority ?? 100) - Number(b.priority ?? 100))
    .flatMap((entry) => {
      const id = entry.slug ?? entry.model ?? entry.id;
      if (typeof id !== "string" || !id.trim() || seen.has(id)) return [];
      seen.add(id);
      return [{ id, displayName: String(entry.display_name ?? entry.displayName ?? id) }];
    });
}

/** Installed CLI model catalog, refreshed by Codex using its own local account auth. */
export async function listCodexModels(): Promise<ModelOption[]> {
  const defaults = [{ id: "default", displayName: "Codex CLI default" }];
  const command = resolveNativeCliCommand("codex");
  for (const args of [
    ["debug", "models"],
    ["debug", "models", "--bundled"],
  ]) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        env: buildNativeCliEnv("codex"),
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const models = parseCodexModelCatalog(JSON.parse(stdout));
      if (models.length) return [...defaults, ...models];
    } catch {
      /* Older/offline CLIs still support their configured default model. */
    }
  }
  return defaults;
}
