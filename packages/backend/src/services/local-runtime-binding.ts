import { satisfies, validRange } from "semver";
import {
  readExecutionEvidence,
  type ProjectExecutionProfile,
  type RuntimeBinding,
} from "./project-execution-profile.service.js";
import type { RecoveryCommandRunner } from "./local-recovery-controller.js";

/** Discovery can choose an installed implementation of a declared tool, never a new validator. */
export async function verifyRuntimeBinding(
  binding: RuntimeBinding,
  profile: ProjectExecutionProfile,
  execute: RecoveryCommandRunner
): Promise<boolean> {
  if (
    !binding ||
    typeof binding.tool !== "string" ||
    typeof binding.executable !== "string" ||
    typeof binding.expectedRange !== "string" ||
    typeof binding.evidencePath !== "string"
  )
    return false;
  if (!profile.runtimeCandidates?.[binding.tool]?.includes(binding.executable)) return false;
  if (!profile.documents?.[binding.evidencePath])
    await readExecutionEvidence(profile, [binding.evidencePath]);
  const document = profile.documents?.[binding.evidencePath];
  const range = validRange(binding.expectedRange);
  const tool = new RegExp(
    `(^|[^A-Za-z0-9_.-])${binding.tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_.-]|$)`
  );
  if (
    !document ||
    !range ||
    range.split("||").some((r) => r.trim() === "*" || r.trim() === "") ||
    !document.split(/\r?\n/).some((line) => tool.test(line) && line.includes(binding.expectedRange))
  )
    return false;
  try {
    const result = await execute(
      { command: binding.executable, args: ["--version"] },
      { cwd: profile.cwd, timeout: 15_000, env: profile.contract?.executionEnvironment }
    );
    const versions = [
      ...new Set(
        [
          ...`${result.stdout}\n${result.stderr}`.matchAll(
            /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\d.])/g
          ),
        ].map((m) => m[1])
      ),
    ];
    return versions.length === 1 && satisfies(versions[0]!, binding.expectedRange);
  } catch {
    return false;
  }
}
