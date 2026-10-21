import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../utils/command-runner.js";

let repoPath: string | undefined;
afterEach(async () => {
  if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
});

it("runs npm launchers with literal arguments on Windows and POSIX", async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "command runner npm "));
  await fs.writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "command-runner-fixture",
      scripts: { args: "node args.cjs" },
    })
  );
  await fs.writeFile(
    path.join(repoPath, "args.cjs"),
    "console.log(JSON.stringify(process.argv.slice(2)))"
  );
  const args = ["two words", "literal&value", "(parentheses)"];
  const result = await runCommand(
    { command: "npm", args: ["run", "--silent", "args", "--", ...args] },
    { cwd: repoPath, timeout: 15_000 }
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual(args);
});
