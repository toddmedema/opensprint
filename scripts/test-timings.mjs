import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { npmInvocation, isMainModule } from "./node-cli.mjs";

const DEFAULT_COMMANDS = [
  {
    id: "backend:test",
    command: ["npm", "run", "test", "-w", "packages/backend", "--", "--reporter=dot"],
  },
  {
    id: "frontend:test",
    command: ["npm", "run", "test", "-w", "packages/frontend", "--", "--reporter=dot"],
  },
  {
    id: "frontend:test:coverage",
    command: ["npm", "run", "test:coverage", "-w", "packages/frontend", "--", "--reporter=dot"],
  },
  { id: "root:test", command: ["npm", "run", "test"] },
  { id: "root:test:affected", command: ["npm", "run", "test:affected"] },
];

function parseArgs(argv) {
  const outIndex = argv.indexOf("--out");
  return {
    outPath:
      outIndex === -1
        ? "artifacts/test-timings/latest.json"
        : (argv[outIndex + 1] ?? "artifacts/test-timings/latest.json"),
  };
}

function resolveTimeCommand() {
  const candidate = "/usr/bin/time";
  return fs
    .access(candidate)
    .then(() => candidate)
    .catch(() => null);
}

function getTimeArgs(command) {
  if (process.platform === "darwin") {
    return ["-lp", ...command];
  }
  return ["-v", ...command];
}

function parseTimeOutput(stderr) {
  const metrics = {};
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonMatch = trimmed.match(/^([^:]+):\s+([0-9.]+)$/);
    const spaceMatch = trimmed.match(/^([A-Za-z ][A-Za-z ()/-]+?)\s+([0-9.]+)$/);
    const match = colonMatch ?? spaceMatch;
    if (!match) continue;
    const [, key, rawValue] = match;
    metrics[key.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = Number(rawValue);
  }
  return metrics;
}

export async function runTimedCommand(timeCommand, spec) {
  const startedAt = Date.now();
  const [cmd, ...args] = spec.command;
  const [executable, ...cliArgs] = cmd === "npm" ? npmInvocation(args) : [cmd, ...args];
  const executableToRun = timeCommand ?? executable;
  const spawnArgs = timeCommand ? getTimeArgs([executable, ...cliArgs]) : cliArgs;

  return await new Promise((resolve) => {
    const child = spawn(executableToRun, spawnArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });

    let spawnError = null;
    child.on("error", (error) => {
      spawnError = error.message;
      console.error(`[test-timings] ${error.message}`);
    });
    child.on("close", (code) => {
      resolve({
        id: spec.id,
        command: spec.command.join(" "),
        exitCode: spawnError ? 1 : (code ?? 1),
        ...(spawnError ? { error: spawnError } : {}),
        wallMs: Date.now() - startedAt,
        metrics: timeCommand ? parseTimeOutput(stderr) : {},
      });
    });
  });
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const timeCommand = await resolveTimeCommand();
  const results = [];

  for (const spec of DEFAULT_COMMANDS) {
    console.log(`\n[test-timings] Running ${spec.id}: ${spec.command.join(" ")}`);
    results.push(await runTimedCommand(timeCommand, spec));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    results,
  };
  const absoluteOutPath = path.resolve(outPath);
  await fs.mkdir(path.dirname(absoluteOutPath), { recursive: true });
  await fs.writeFile(absoluteOutPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\n[test-timings] Wrote ${absoluteOutPath}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
