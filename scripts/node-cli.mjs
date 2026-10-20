import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Compare normalized file URLs, including Windows drive letters and escaped spaces. */
export function isMainModule(moduleUrl) {
  return Boolean(
    process.argv[1] && moduleUrl === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

/** npm's .cmd/.sh shims require a shell; run its installed JavaScript CLI directly. */
export function npmInvocation(args) {
  const candidates = [process.env.npm_execpath];
  try {
    candidates.push(createRequire(import.meta.url).resolve("npm/bin/npm-cli.js"));
  } catch {
    // Standalone Node runs do not necessarily resolve globally installed npm.
  }
  candidates.push(
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    )
  );
  const cli = candidates.find(
    (candidate) =>
      candidate && path.basename(candidate) === "npm-cli.js" && fs.existsSync(candidate)
  );
  if (!cli)
    throw new Error(
      "Could not locate npm's JavaScript CLI; run through npm or install npm beside Node."
    );
  return [process.execPath, cli, ...args];
}
