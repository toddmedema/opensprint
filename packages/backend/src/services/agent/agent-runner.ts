import type { CodingAgentHandle } from "./agent-types.js";

export type AgentRunnerState =
  | "queued"
  | "running"
  | "stop_requested"
  | "stopped"
  | "completed"
  | "uncertain";

/** One invocation's control surface. Cancellation is not confirmation of process exit. */
export class AgentRunner {
  private handle: CodingAgentHandle | null = null;
  private state: AgentRunnerState = "queued";
  private readonly completedObservers: Array<() => void> = [];
  readonly controller = new AbortController();
  notifyCompletionOnCancel = false;

  constructor(readonly attemptId: string) {}

  start(invoke: () => CodingAgentHandle): CodingAgentHandle | null {
    if (this.controller.signal.aborted || this.state !== "queued") return null;
    this.state = "running";
    const handle = invoke();
    this.handle = handle;
    if (this.controller.signal.aborted) handle.kill();
    // An invocation may synchronously report completion while returning its handle.
    return this.state === "running" ? handle : null;
  }

  observe(): {
    attemptId: string;
    state: AgentRunnerState;
    pid: number | null;
    ownership: "local" | "recovered_unverified";
  } {
    return {
      attemptId: this.attemptId,
      state: this.state,
      pid: this.handle?.pid ?? null,
      ownership: this.handle?.ownership ?? "local",
    };
  }

  steer(message: string): boolean {
    return this.state === "running" && Boolean(this.handle?.pendingMessages?.push(message));
  }

  cancel(notifyCompletion = false): void {
    if (this.handle?.ownership === "recovered_unverified") {
      this.state = "uncertain";
      return;
    }
    if (this.controller.signal.aborted || this.state === "completed" || this.state === "stopped")
      return;
    this.notifyCompletionOnCancel = notifyCompletion;
    const queued = this.state === "queued";
    this.controller.abort();
    this.state = queued ? "stopped" : "stop_requested";
    if (queued) this.notifyCompleted();
    try {
      this.handle?.pendingMessages?.close();
    } finally {
      this.handle?.kill();
    }
  }
  markUncertain(): void {
    this.state = "uncertain";
  }
  waitForCompletion(): Promise<void> {
    if (this.state === "stopped" || this.state === "completed") return Promise.resolve();
    return new Promise((resolve) => this.completedObservers.push(resolve));
  }
  private notifyCompleted(): void {
    for (const resolve of this.completedObservers.splice(0)) resolve();
  }

  complete(): void {
    this.state = this.controller.signal.aborted ? "stopped" : "completed";
    this.notifyCompleted();
  }
}
