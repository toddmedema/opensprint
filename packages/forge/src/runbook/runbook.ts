import { createHash } from "node:crypto";
import path from "node:path";
import type { RunbookCommand, RunbookDocument, RunbookGate } from "../domain.js";
import { ForgeError } from "../errors.js";

const DENIED_ARGV0 = new Set(["sudo", "su", "curl", "wget", "bash", "sh", "zsh", "ssh", "env"]);
const VIRTUAL_ROOT = path.resolve("/forge-checkout");

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function digestDocument(document: RunbookDocument): string {
  return sha256(canonicalJson(document));
}

export function executionContractHash(
  digest: string,
  document: RunbookDocument,
  runtimeArgv: string[]
): string {
  return sha256(
    canonicalJson({
      digest,
      install: document.install,
      gates: document.gates.filter((gate) => gate.required),
      runtime: runtimeArgv,
    })
  );
}

export function assertCommand(
  command: RunbookCommand,
  options: { allowEnv: boolean; checkoutRoot?: string }
): { cwd: string } {
  if (!Array.isArray(command.argv) || command.argv.length === 0) {
    throw new ForgeError(400, "invalid_argv", "argv must be a non-empty string array.");
  }
  if (command.argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new ForgeError(400, "invalid_argv", "argv must be a non-empty string array.");
  }
  if (!Number.isInteger(command.timeoutSec) || command.timeoutSec < 1 || command.timeoutSec > 1200) {
    throw new ForgeError(400, "invalid_timeout", "timeoutSec must be an integer from 1 to 1200.");
  }
  const root = path.resolve(options.checkoutRoot ?? VIRTUAL_ROOT);
  const cwd = path.resolve(root, command.cwd || ".");
  const relative = path.relative(root, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ForgeError(400, "invalid_cwd", "cwd must stay inside the checkout.");
  }
  const bin = command.argv[0] ?? "";
  const base = path.basename(bin);
  if (DENIED_ARGV0.has(base.toLowerCase())) {
    throw new ForgeError(400, "denied_argv", `${base} cannot be argv[0].`);
  }
  if (bin.includes("/") || bin.includes("\\")) {
    const resolved = path.resolve(cwd, bin);
    const binRelative = path.relative(root, resolved);
    if (binRelative.startsWith("..") || path.isAbsolute(binRelative)) {
      throw new ForgeError(
        400,
        "denied_argv",
        "argv[0] must be a bare name or a path inside the checkout."
      );
    }
  } else if (bin !== base) {
    throw new ForgeError(
      400,
      "denied_argv",
      "argv[0] must be a bare name or a path inside the checkout."
    );
  }
  if (command.env) {
    if (!options.allowEnv) {
      throw new ForgeError(400, "invalid_env", "Only the install slot may declare env names.");
    }
    if (
      !Array.isArray(command.env) ||
      command.env.some((name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name))
    ) {
      throw new ForgeError(400, "invalid_env", "Install env entries must be variable names.");
    }
  }
  return { cwd };
}

export function assertRuntimeArgv(argv: string[], timeoutSec: number): void {
  assertCommand({ argv, cwd: ".", timeoutSec }, { allowEnv: false });
  const bin = argv[0] ?? "";
  if (bin.includes("/") || bin.includes("\\")) {
    throw new ForgeError(400, "denied_argv", "The agent runtime argv[0] must be a bare name.");
  }
}

function asCommand(value: unknown, allowEnv: boolean): RunbookCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ForgeError(400, "invalid_runbook", "A runbook command must be an object.");
  }
  const record = value as Record<string, unknown>;
  const command: RunbookCommand = {
    argv: record.argv as string[],
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    timeoutSec: record.timeoutSec as number,
  };
  if (record.env !== undefined) command.env = record.env as string[];
  assertCommand(command, { allowEnv });
  return command;
}

export function validateRunbook(input: unknown): RunbookDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ForgeError(400, "invalid_runbook", "Runbook must be an object.");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "install",
    "health",
    "gates",
    "ship",
    "runtimeTools",
    "dependencyPaths",
    "blockedPaths",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ForgeError(400, "invalid_runbook", `Unknown runbook field ${key}.`);
    }
  }
  if (record.version !== 1) {
    throw new ForgeError(400, "invalid_runbook", "Runbook version must be 1.");
  }
  if (!Object.hasOwn(record, "ship") || record.ship !== null) {
    throw new ForgeError(400, "invalid_runbook", "The ship slot stays empty.");
  }
  const install =
    record.install == null ? null : asCommand(record.install, true);
  const health = record.health == null ? null : asCommand(record.health, false);
  if (!Array.isArray(record.gates)) {
    throw new ForgeError(400, "invalid_runbook", "gates must be an array.");
  }
  const gates: RunbookGate[] = record.gates.map((gate) => {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      throw new ForgeError(400, "invalid_runbook", "Each gate must be an object.");
    }
    const row = gate as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.trim() === "") {
      throw new ForgeError(400, "invalid_runbook", "Each gate needs an id.");
    }
    if (typeof row.required !== "boolean") {
      throw new ForgeError(400, "invalid_runbook", "Each gate needs required true or false.");
    }
    const command = asCommand(gate, false);
    return { ...command, id: row.id, required: row.required };
  });
  const ids = new Set<string>();
  for (const gate of gates) {
    if (ids.has(gate.id)) throw new ForgeError(400, "invalid_runbook", `Duplicate gate ${gate.id}.`);
    ids.add(gate.id);
  }
  if (!gates.some((gate) => gate.required)) {
    throw new ForgeError(400, "invalid_runbook", "A runbook needs at least one required gate.");
  }
  const runtimeTools = stringList(record.runtimeTools, "runtimeTools");
  for (const tool of runtimeTools) {
    if (tool.includes("/") || DENIED_ARGV0.has(tool.toLowerCase())) {
      throw new ForgeError(400, "invalid_runbook", `Runtime tool ${tool} is not allowed.`);
    }
  }
  return {
    version: 1,
    install,
    health,
    gates,
    ship: null,
    runtimeTools,
    dependencyPaths: stringList(record.dependencyPaths, "dependencyPaths"),
    blockedPaths: stringList(record.blockedPaths, "blockedPaths"),
  };
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ForgeError(400, "invalid_runbook", `${label} must be a string array.`);
  }
  return value;
}

export interface LabeledCommand {
  label: string;
  argv: string[];
  cwd: string;
  timeoutSec: number;
  env?: string[];
}

export function probeCommands(document: RunbookDocument): LabeledCommand[] {
  const commands: LabeledCommand[] = [];
  if (document.install) commands.push({ label: "install", ...document.install });
  if (document.health) commands.push({ label: "health", ...document.health });
  for (const gate of document.gates) {
    if (!gate.required) continue;
    commands.push({ label: `gate:${gate.id}`, ...gate });
  }
  return commands;
}

export function gradeCommands(document: RunbookDocument): LabeledCommand[] {
  return document.gates
    .filter((gate) => gate.required)
    .map((gate) => ({ label: `gate:${gate.id}`, ...gate }));
}

export function assertRemoteUrl(url: string): void {
  if (/[\n\r]/.test(url) || url.includes("ext::") || url.includes("--upload-pack")) {
    throw new ForgeError(400, "invalid_remote", "Remote URL is not allowed.");
  }
  if (/^https?:\/\/[^/\s]*@/.test(url)) {
    throw new ForgeError(400, "invalid_remote", "Put credentials in the credential field.");
  }
  if (/^https?:\/\//.test(url) || url.startsWith("file://")) return;
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) return;
  throw new ForgeError(400, "invalid_remote", "Use an https URL or a local git path.");
}

export function isLocalRemote(url: string): boolean {
  return url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || url.startsWith("file://");
}
