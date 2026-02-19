import { describe, it, expect, vi, beforeEach } from "vitest";
import deliverReducer, {
  appendDeliverOutput,
  deliverStarted,
  deliverCompleted,
  setSelectedDeployId,
  resetDeliver,
} from "./deliverSlice";

describe("deliverSlice", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should have correct initial state", () => {
    const state = deliverReducer(undefined, { type: "unknown" });
    expect(state.history).toEqual([]);
    expect(state.currentDeploy).toBeNull();
    expect(state.activeDeployId).toBeNull();
    expect(state.selectedDeployId).toBeNull();
    expect(state.liveLog).toEqual([]);
  });

  it("should handle deliverStarted", () => {
    const state = deliverReducer(undefined, deliverStarted({ deployId: "deploy-123" }));
    expect(state.activeDeployId).toBe("deploy-123");
    expect(state.selectedDeployId).toBe("deploy-123");
    expect(state.liveLog).toEqual([]);
  });

  it("should handle appendDeliverOutput", () => {
    let state = deliverReducer(undefined, deliverStarted({ deployId: "deploy-123" }));
    state = deliverReducer(
      state,
      appendDeliverOutput({ deployId: "deploy-123", chunk: "line1\n" })
    );
    state = deliverReducer(
      state,
      appendDeliverOutput({ deployId: "deploy-123", chunk: "line2\n" })
    );
    expect(state.liveLog).toEqual(["line1\n", "line2\n"]);
  });

  it("should ignore appendDeliverOutput for non-selected deploy", () => {
    let state = deliverReducer(undefined, setSelectedDeployId("deploy-456"));
    state = deliverReducer(state, appendDeliverOutput({ deployId: "deploy-123", chunk: "x" }));
    expect(state.liveLog).toEqual([]);
  });

  it("should handle deliverCompleted", () => {
    let state = deliverReducer(undefined, deliverStarted({ deployId: "deploy-123" }));
    state = deliverReducer(state, deliverCompleted({ deployId: "deploy-123", success: true }));
    expect(state.activeDeployId).toBeNull();
  });

  it("should update history record with fixEpicId when deliverCompleted has fixEpicId", () => {
    const history = [
      {
        id: "deploy-1",
        projectId: "proj-1",
        status: "failed" as const,
        startedAt: "2025-01-01T12:00:00.000Z",
        completedAt: "2025-01-01T12:01:00.000Z",
        log: [],
      },
    ];
    const stateWithHistory = deliverReducer(undefined, { type: "unknown" });
    const state = deliverReducer(
      { ...stateWithHistory, history },
      deliverCompleted({ deployId: "deploy-1", success: false, fixEpicId: "bd-abc123" })
    );
    expect(state.history[0]).toMatchObject({ fixEpicId: "bd-abc123" });
  });

  it("should handle setSelectedDeployId", () => {
    const state = deliverReducer(undefined, setSelectedDeployId("deploy-456"));
    expect(state.selectedDeployId).toBe("deploy-456");
  });

  it("should handle resetDeliver", () => {
    let state = deliverReducer(undefined, deliverStarted({ deployId: "deploy-123" }));
    state = deliverReducer(state, resetDeliver());
    expect(state).toMatchObject({
      history: [],
      activeDeployId: null,
      selectedDeployId: null,
      liveLog: [],
    });
  });
});
