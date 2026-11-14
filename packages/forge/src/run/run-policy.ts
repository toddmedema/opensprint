import type { EvidenceItem, RunState } from "../domain.js";
import { HEARTBEAT_MS } from "../domain.js";

export type PatrolAction =
  | { type: "leave"; reason: "human_owned" | "owned_process" | "heartbeat" | "live_pid" }
  | { type: "resume_verify" }
  | { type: "resume_gate" }
  | { type: "resume_integrate" }
  | { type: "complete_from_result" }
  | { type: "retry_once" }
  | { type: "hold"; reason: string };

export function decidePatrol(input: {
  humanOwned: boolean;
  heartbeatFresh: boolean;
  pidAlive: boolean;
  ownsProcess: boolean;
  resultPresent: boolean;
  retryCount: number;
  state: RunState;
}): PatrolAction {
  if (input.humanOwned) return { type: "leave", reason: "human_owned" };
  if (input.ownsProcess && (input.state === "running" || input.state === "assigned")) {
    return { type: "leave", reason: "owned_process" };
  }
  if (input.heartbeatFresh || input.pidAlive) {
    return { type: "leave", reason: input.heartbeatFresh ? "heartbeat" : "live_pid" };
  }
  if (input.state === "verifying") return { type: "resume_verify" };
  if (input.state === "gating") return { type: "resume_gate" };
  if (input.state === "integrating") return { type: "resume_integrate" };
  if (input.resultPresent) return { type: "complete_from_result" };
  if (input.retryCount === 0) return { type: "retry_once" };
  return { type: "hold", reason: "result_missing" };
}

export function heartbeatFresh(heartbeatAt: string | null, now: number): boolean {
  if (!heartbeatAt) return false;
  const then = Date.parse(heartbeatAt);
  if (Number.isNaN(then)) return false;
  return now - then < HEARTBEAT_MS;
}

export type VerifyKind = "deps" | "binding" | "code";

export function classifyVerifyEvidence(evidence: EvidenceItem[]): VerifyKind {
  const text = evidence.map((item) => item.excerpt).join("\n");
  if (
    evidence.some((item) => item.exitCode === 127) ||
    /ENOENT|command not found|Cannot find module|MODULE_NOT_FOUND|No such file or directory|missing dependency/i.test(
      text
    )
  ) {
    return "deps";
  }
  if (/bad interpreter|tool binding|not executable/i.test(text)) return "binding";
  return "code";
}

export function decideVerifyFailure(input: {
  kind: VerifyKind;
  verifyHealCount: number;
  codeRetryCount: number;
  hasInstall: boolean;
  hasTools: boolean;
}): "heal_install" | "rebind" | "retry_worker" | "hold" {
  if ((input.kind === "deps" || input.kind === "binding") && input.verifyHealCount < 1) {
    if (input.kind === "deps" && input.hasInstall) return "heal_install";
    if (input.hasTools || input.kind === "binding") return "rebind";
    if (input.hasInstall) return "heal_install";
    return "hold";
  }
  if (input.kind === "code" && input.codeRetryCount < 2) return "retry_worker";
  return "hold";
}

export function failureSignature(evidence: EvidenceItem[]): string {
  const first = evidence.find((item) => item.exitCode !== 0) ?? evidence[0];
  const line = (first?.excerpt ?? "").split("\n")[0]?.slice(0, 180) ?? "";
  return `${first?.command ?? "gate"}:${first?.exitCode ?? 1}:${line}`;
}

export function rebindArgv(argv: string[], bindings: Record<string, string>): string[] {
  const [first, ...rest] = argv;
  if (first && bindings[first]) return [bindings[first], ...rest];
  return [...argv];
}
