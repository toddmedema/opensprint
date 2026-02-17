import { describe, it, expect, vi, beforeEach } from "vitest";
import deployReducer, {
  appendDeployOutput,
  deployStarted,
  deployCompleted,
  setSelectedDeployId,
  resetDeploy,
} from "./deploySlice";

describe("deploySlice", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should have correct initial state", () => {
    const state = deployReducer(undefined, { type: "unknown" });
    expect(state.history).toEqual([]);
    expect(state.currentDeploy).toBeNull();
    expect(state.activeDeployId).toBeNull();
    expect(state.selectedDeployId).toBeNull();
    expect(state.liveLog).toEqual([]);
  });

  it("should handle deployStarted", () => {
    const state = deployReducer(
      undefined,
      deployStarted({ deployId: "deploy-123" }),
    );
    expect(state.activeDeployId).toBe("deploy-123");
    expect(state.selectedDeployId).toBe("deploy-123");
    expect(state.liveLog).toEqual([]);
  });

  it("should handle appendDeployOutput", () => {
    let state = deployReducer(undefined, deployStarted({ deployId: "deploy-123" }));
    state = deployReducer(state, appendDeployOutput({ deployId: "deploy-123", chunk: "line1\n" }));
    state = deployReducer(state, appendDeployOutput({ deployId: "deploy-123", chunk: "line2\n" }));
    expect(state.liveLog).toEqual(["line1\n", "line2\n"]);
  });

  it("should ignore appendDeployOutput for non-selected deploy", () => {
    let state = deployReducer(undefined, setSelectedDeployId("deploy-456"));
    state = deployReducer(state, appendDeployOutput({ deployId: "deploy-123", chunk: "x" }));
    expect(state.liveLog).toEqual([]);
  });

  it("should handle deployCompleted", () => {
    let state = deployReducer(undefined, deployStarted({ deployId: "deploy-123" }));
    state = deployReducer(state, deployCompleted({ deployId: "deploy-123", success: true }));
    expect(state.activeDeployId).toBeNull();
  });

  it("should handle setSelectedDeployId", () => {
    const state = deployReducer(undefined, setSelectedDeployId("deploy-456"));
    expect(state.selectedDeployId).toBe("deploy-456");
  });

  it("should handle resetDeploy", () => {
    let state = deployReducer(undefined, deployStarted({ deployId: "deploy-123" }));
    state = deployReducer(state, resetDeploy());
    expect(state).toMatchObject({
      history: [],
      activeDeployId: null,
      selectedDeployId: null,
      liveLog: [],
    });
  });
});
