import os from "node:os";
import { sanitizedEnv } from "../redact.js";
import { canonicalJson, sha256 } from "../runbook/runbook.js";
import { runArgv } from "../verify/exec.js";

export const REPLAY_NOTE =
  "Replay is strong evidence about a cooperative agent. Checks that run against the coder's own workspace can still be influenced by that code.";

export interface ReplayFixture {
  inputs: unknown;
  heldOut: unknown[];
}

export interface ReplayReport {
  imageDigest: string | null;
  network: "none" | "unknown";
  isolation: "docker" | "unavailable";
  originalInputsPresent: boolean;
  heldOut: Array<{ name: string; passed: boolean; skipped?: boolean }>;
  metrics: { replayAgreement: number } | { placeholder: true } | null;
  missing: string[];
  note: string;
}

export type ReplayRunner = (input: {
  image: string | null;
  fixture: ReplayFixture;
}) => Promise<ReplayReport>;

export function emptyReplay(image: string | null): ReplayReport {
  return {
    imageDigest: image,
    network: "unknown",
    isolation: "unavailable",
    originalInputsPresent: false,
    heldOut: [],
    metrics: null,
    missing: [],
    note: REPLAY_NOTE,
  };
}

export function normalizeReplay(report: ReplayReport): {
  status: "complete" | "incomplete";
  report: ReplayReport;
} {
  const missing = new Set(report.missing);
  if (!report.originalInputsPresent) missing.add("missing_inputs");
  if (report.isolation !== "docker") missing.add("isolation_unavailable");
  if (report.network !== "none") missing.add("network");
  if (!report.imageDigest) missing.add("missing_image");
  if (report.heldOut.length === 0 || report.heldOut.some((item) => item.skipped || !item.passed)) {
    missing.add("held_out");
  }
  const metrics = report.metrics;
  if (!metrics || "placeholder" in metrics || typeof metrics.replayAgreement !== "number") {
    missing.add("placeholder_metrics");
  }
  const next = { ...report, missing: [...missing], note: REPLAY_NOTE };
  return { status: next.missing.length === 0 ? "complete" : "incomplete", report: next };
}

export function dockerReplayRunner(image: string | null): ReplayRunner {
  return async ({ fixture }) => {
    const report = emptyReplay(image);
    report.originalInputsPresent = fixture.inputs != null && fixture.heldOut.length > 0;
    if (!image) {
      report.missing = ["missing_image", "isolation_unavailable"];
      return report;
    }
    if (!report.originalInputsPresent) {
      report.missing = ["missing_inputs"];
      return report;
    }
    const payload = canonicalJson(fixture);
    const inputsDigest = sha256(payload);
    const result = await runArgv({
      argv: ["docker", "run", "-i", "--network", "none", "--rm", "--pull", "never", image],
      cwd: os.tmpdir(),
      timeoutSec: 30,
      checkoutRoot: os.tmpdir(),
      env: sanitizedEnv(process.env, [image]),
      stdin: payload,
    });
    report.network = "none";
    if (result.exitCode !== 0) {
      report.missing = ["isolation_unavailable"];
      return report;
    }
    const parsed = readMetrics(result.excerpt);
    report.originalInputsPresent = parsed?.inputsDigest === inputsDigest;
    if (!parsed || parsed.inputsDigest !== inputsDigest) {
      report.isolation = "docker";
      report.missing = ["placeholder_metrics"];
      return report;
    }
    report.isolation = "docker";
    report.metrics = { replayAgreement: parsed.replayAgreement };
    report.heldOut = parsed.heldOut;
    report.missing = [];
    return report;
  };
}

function readMetrics(excerpt: string): {
  replayAgreement: number;
  inputsDigest: string;
  heldOut: Array<{ name: string; passed: boolean }>;
} | null {
  for (const line of excerpt.split("\n")) {
    try {
      const parsed = JSON.parse(line) as {
        replayAgreement?: number;
        inputsDigest?: string;
        heldOut?: Array<{ name?: string; passed?: boolean }>;
      };
      if (
        typeof parsed.replayAgreement !== "number" ||
        typeof parsed.inputsDigest !== "string" ||
        !Array.isArray(parsed.heldOut)
      ) {
        continue;
      }
      return {
        replayAgreement: parsed.replayAgreement,
        inputsDigest: parsed.inputsDigest,
        heldOut: parsed.heldOut.map((item, index) => ({
          name: item.name || `held-out-${index + 1}`,
          passed: item.passed === true,
        })),
      };
    } catch {
      // Keep looking for a metrics line.
    }
  }
  return null;
}
