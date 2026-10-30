import process from "node:process";
import { spawnSync } from "node:child_process";
import { getAffectedWorkspaces } from "./affected-workspaces.mjs";

import { npmInvocation, isMainModule } from "./node-cli.mjs";

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  const mainArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const passthroughArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  const scriptName = mainArgs[0] ?? "test";
  const coverageOnly = scriptName === "test:coverage";
  return { scriptName, passthroughArgs, coverageOnly };
}

function run() {
  const { scriptName, passthroughArgs, coverageOnly } = parseArgs(process.argv.slice(2));
  const result = getAffectedWorkspaces({ coverageOnly });

  if (result.workspaces.length === 0) {
    console.log(`[affected-tests] No affected workspaces for ${scriptName}; skipping.`);
    return;
  }

  console.log(
    `[affected-tests] Running ${scriptName} for: ${result.workspaces.join(", ")} (${result.reason})`
  );

  for (const workspace of result.workspaces) {
    const args = ["run", scriptName, "-w", `packages/${workspace}`];
    if (passthroughArgs.length > 0) {
      args.push("--", ...passthroughArgs);
    }

    const [executable, ...cliArgs] = npmInvocation(args);
    const child = spawnSync(executable, cliArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    if (child.error) console.error(`[affected-tests] ${child.error.message}`);
    if (child.status !== 0) {
      process.exit(child.status ?? 1);
    }
  }
}

if (isMainModule(import.meta.url)) run();
