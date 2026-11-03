import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getClaudeCliEffortCapabilities,
  isAgentEffort,
  type AgentConfig,
  type AgentModelOption,
} from "@opensprint/shared";
import { buildNativeCliEnv, resolveNativeCliCommand } from "../utils/native-cli.js";

const execFileAsync = promisify(execFile);
type ModelOption = AgentModelOption;

// Claude's supported aliases track new versions without requiring API credentials.
// https://code.claude.com/docs/en/model-config
export const CLAUDE_CLI_MODELS: ModelOption[] = [
  { id: "default", displayName: "Claude Code default" },
  { id: "sonnet", displayName: "Claude Sonnet (latest)" },
  { id: "opus", displayName: "Claude Opus (latest)" },
  { id: "haiku", displayName: "Claude Haiku (latest)" },
  { id: "fable", displayName: "Claude Fable (latest; usage credits may apply)" },
].map((model) => ({ ...model, ...getClaudeCliEffortCapabilities(model.id) }));

export function parseCodexModelCatalog(raw: unknown): ModelOption[] {
  const envelope = raw as { result?: unknown };
  const body = (envelope?.result ?? raw) as { models?: unknown[]; data?: unknown[] };
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
      const levels = entry.supported_reasoning_levels ?? entry.supportedReasoningEfforts;
      const defaultEffort = entry.default_reasoning_level ?? entry.defaultReasoningEffort;
      const supportedEfforts = Array.isArray(levels)
        ? levels.flatMap((level) => {
            const option = level as {
              effort?: unknown;
              reasoningEffort?: unknown;
              description?: unknown;
            };
            const effort =
              typeof level === "string" ? level : (option?.effort ?? option?.reasoningEffort);
            return isAgentEffort(effort)
              ? [
                  {
                    effort,
                    ...(typeof option?.description === "string"
                      ? { description: option.description }
                      : {}),
                  },
                ]
              : [];
          })
        : undefined;
      return [
        {
          id,
          displayName: String(entry.display_name ?? entry.displayName ?? id),
          ...(supportedEfforts !== undefined ? { supportedEfforts } : {}),
          ...(isAgentEffort(defaultEffort) &&
          supportedEfforts?.some((level) => level.effort === defaultEffort)
            ? { defaultEffort }
            : {}),
        },
      ];
    });
}

/** Installed CLI model catalog, refreshed by Codex using its own local account auth. */
export async function listCodexModels(): Promise<ModelOption[]> {
  const defaults: ModelOption[] = [
    { id: "default", displayName: "Codex CLI default", supportedEfforts: [] },
  ];
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

/** Fail closed when an explicit override cannot be verified; retain the saved setting. */
export async function assertNativeCliEffort(config: AgentConfig): Promise<void> {
  if (!config.effort) return;
  const model =
    config.type === "claude-cli"
      ? getClaudeCliEffortCapabilities(config.model)
      : config.type === "codex"
        ? (await listCodexModels()).find((entry) => entry.id === config.model)
        : undefined;
  if (!model?.supportedEfforts?.some((level) => level.effort === config.effort)) {
    throw new Error(
      `Cannot verify ${config.effort} effort for ${config.type} model ${config.model ?? "default"}. Choose a supported effort or CLI default in Agent Config.`
    );
  }
}
