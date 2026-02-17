import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import planReducer, {
  fetchPlans,
  decomposePlans,
  shipPlan,
  reshipPlan,
  fetchPlanChat,
  sendPlanMessage,
  fetchSinglePlan,
  archivePlan,
  setSelectedPlanId,
  addPlanLocally,
  setPlanError,
  setPlansAndGraph,
  resetPlan,
  type PlanState,
} from "./planSlice";
import type { Plan, PlanDependencyGraph } from "@opensprint/shared";

vi.mock("../../api/client", () => ({
  api: {
    plans: {
      list: vi.fn(),
      decompose: vi.fn(),
      ship: vi.fn(),
      reship: vi.fn(),
      archive: vi.fn(),
      get: vi.fn(),
    },
    chat: {
      history: vi.fn(),
      send: vi.fn(),
    },
  },
}));

import { api } from "../../api/client";

const mockPlan: Plan = {
  metadata: {
    planId: "plan-1",
    beadEpicId: "epic-1",
    gateTaskId: "gate-1",
    shippedAt: null,
    complexity: "medium",
  },
  content: "# Plan 1\n\nDescription",
  status: "planning",
  taskCount: 3,
  doneTaskCount: 0,
  dependencyCount: 0,
};

const mockGraph: PlanDependencyGraph = {
  plans: [mockPlan],
  edges: [],
};

describe("planSlice", () => {
  beforeEach(() => {
    vi.mocked(api.plans.list).mockReset();
    vi.mocked(api.plans.decompose).mockReset();
    vi.mocked(api.plans.ship).mockReset();
    vi.mocked(api.plans.reship).mockReset();
    vi.mocked(api.plans.archive).mockReset();
    vi.mocked(api.plans.get).mockReset();
    vi.mocked(api.chat.history).mockReset();
    vi.mocked(api.chat.send).mockReset();
  });

  function createStore() {
    return configureStore({ reducer: { plan: planReducer } });
  }

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = createStore();
      const state = store.getState().plan as PlanState;
      expect(state.plans).toEqual([]);
      expect(state.dependencyGraph).toBeNull();
      expect(state.selectedPlanId).toBeNull();
      expect(state.chatMessages).toEqual({});
      expect(state.loading).toBe(false);
      expect(state.decomposing).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("reducers", () => {
    it("setSelectedPlanId sets selected plan", () => {
      const store = createStore();
      store.dispatch(setSelectedPlanId("plan-123"));
      expect(store.getState().plan.selectedPlanId).toBe("plan-123");
      store.dispatch(setSelectedPlanId(null));
      expect(store.getState().plan.selectedPlanId).toBeNull();
    });

    it("addPlanLocally appends plan", () => {
      const store = createStore();
      store.dispatch(addPlanLocally(mockPlan));
      expect(store.getState().plan.plans).toHaveLength(1);
      expect(store.getState().plan.plans[0]).toEqual(mockPlan);
    });

    it("setPlanError sets error", () => {
      const store = createStore();
      store.dispatch(setPlanError("Something went wrong"));
      expect(store.getState().plan.error).toBe("Something went wrong");
      store.dispatch(setPlanError(null));
      expect(store.getState().plan.error).toBeNull();
    });

    it("setPlansAndGraph sets plans and dependencyGraph", () => {
      const store = createStore();
      store.dispatch(setPlansAndGraph({ plans: [mockPlan], dependencyGraph: mockGraph }));
      expect(store.getState().plan.plans).toEqual([mockPlan]);
      expect(store.getState().plan.dependencyGraph).toEqual(mockGraph);
    });

    it("resetPlan resets state to initial values", () => {
      const store = createStore();
      store.dispatch(addPlanLocally(mockPlan));
      store.dispatch(setSelectedPlanId("plan-1"));
      store.dispatch(setPlanError("error"));

      store.dispatch(resetPlan());
      const state = store.getState().plan as PlanState;
      expect(state.plans).toEqual([]);
      expect(state.dependencyGraph).toBeNull();
      expect(state.selectedPlanId).toBeNull();
      expect(state.chatMessages).toEqual({});
      expect(state.loading).toBe(false);
      expect(state.decomposing).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("fetchPlans thunk", () => {
    it("sets loading true and clears error on pending", async () => {
      let resolveApi: (v: PlanDependencyGraph) => void;
      const apiPromise = new Promise<PlanDependencyGraph>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.plans.list).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(fetchPlans("proj-1"));

      expect(store.getState().plan.loading).toBe(true);
      expect(store.getState().plan.error).toBeNull();

      resolveApi!(mockGraph);
      await dispatchPromise;
    });

    it("stores plans and dependencyGraph on fulfilled", async () => {
      vi.mocked(api.plans.list).mockResolvedValue(mockGraph);
      const store = createStore();
      await store.dispatch(fetchPlans("proj-1"));

      const state = store.getState().plan;
      expect(state.plans).toEqual([mockPlan]);
      expect(state.dependencyGraph).toEqual(mockGraph);
      expect(state.loading).toBe(false);
      expect(api.plans.list).toHaveBeenCalledWith("proj-1");
    });

    it("sets error and clears loading on rejected", async () => {
      vi.mocked(api.plans.list).mockRejectedValue(new Error("Network error"));
      const store = createStore();
      await store.dispatch(fetchPlans("proj-1"));

      const state = store.getState().plan;
      expect(state.loading).toBe(false);
      expect(state.error).toBe("Network error");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.plans.list).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(fetchPlans("proj-1"));

      expect(store.getState().plan.error).toBe("Failed to load plans");
    });
  });

  describe("decomposePlans thunk", () => {
    it("sets decomposing true on pending", async () => {
      let resolveApi: () => void;
      const apiPromise = new Promise<void>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.plans.decompose).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(decomposePlans("proj-1"));

      expect(store.getState().plan.decomposing).toBe(true);
      expect(store.getState().plan.error).toBeNull();

      resolveApi!();
      await dispatchPromise;
    });

    it("clears decomposing on fulfilled", async () => {
      vi.mocked(api.plans.decompose).mockResolvedValue({ created: 2, plans: [] });
      const store = createStore();
      await store.dispatch(decomposePlans("proj-1"));

      expect(store.getState().plan.decomposing).toBe(false);
      expect(api.plans.decompose).toHaveBeenCalledWith("proj-1");
    });

    it("clears decomposing and sets error on rejected", async () => {
      vi.mocked(api.plans.decompose).mockRejectedValue(new Error("Decompose failed"));
      const store = createStore();
      await store.dispatch(decomposePlans("proj-1"));

      const state = store.getState().plan;
      expect(state.decomposing).toBe(false);
      expect(state.error).toBe("Decompose failed");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.plans.decompose).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(decomposePlans("proj-1"));

      expect(store.getState().plan.error).toBe("Failed to decompose PRD");
    });
  });

  describe("shipPlan thunk", () => {
    it("sets shippingPlanId on pending", async () => {
      let resolveApi: () => void;
      const apiPromise = new Promise<void>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.plans.ship).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        shipPlan({ projectId: "proj-1", planId: "plan-123" }),
      );

      expect(store.getState().plan.shippingPlanId).toBe("plan-123");
      expect(store.getState().plan.error).toBeNull();

      resolveApi!();
      await dispatchPromise;
    });

    it("clears shippingPlanId on fulfilled", async () => {
      vi.mocked(api.plans.ship).mockResolvedValue(undefined);
      const store = createStore();
      await store.dispatch(shipPlan({ projectId: "proj-1", planId: "plan-123" }));

      expect(store.getState().plan.shippingPlanId).toBeNull();
      expect(api.plans.ship).toHaveBeenCalledWith("proj-1", "plan-123");
    });

    it("clears shippingPlanId and sets error on rejected", async () => {
      vi.mocked(api.plans.ship).mockRejectedValue(new Error("Ship failed"));
      const store = createStore();
      await store.dispatch(shipPlan({ projectId: "proj-1", planId: "plan-123" }));

      const state = store.getState().plan;
      expect(state.shippingPlanId).toBeNull();
      expect(state.error).toBe("Ship failed");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.plans.ship).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(shipPlan({ projectId: "proj-1", planId: "plan-123" }));

      expect(store.getState().plan.error).toBe("Failed to start build");
    });
  });

  describe("reshipPlan thunk", () => {
    it("sets reshippingPlanId on pending", async () => {
      let resolveApi: () => void;
      const apiPromise = new Promise<void>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.plans.reship).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        reshipPlan({ projectId: "proj-1", planId: "plan-456" }),
      );

      expect(store.getState().plan.reshippingPlanId).toBe("plan-456");

      resolveApi!();
      await dispatchPromise;
    });

    it("clears reshippingPlanId on fulfilled", async () => {
      vi.mocked(api.plans.reship).mockResolvedValue(undefined);
      const store = createStore();
      await store.dispatch(reshipPlan({ projectId: "proj-1", planId: "plan-456" }));

      expect(store.getState().plan.reshippingPlanId).toBeNull();
      expect(api.plans.reship).toHaveBeenCalledWith("proj-1", "plan-456");
    });

    it("clears reshippingPlanId and sets error on rejected", async () => {
      vi.mocked(api.plans.reship).mockRejectedValue(new Error("Reship failed"));
      const store = createStore();
      await store.dispatch(reshipPlan({ projectId: "proj-1", planId: "plan-456" }));

      const state = store.getState().plan;
      expect(state.reshippingPlanId).toBeNull();
      expect(state.error).toBe("Reship failed");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.plans.reship).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(reshipPlan({ projectId: "proj-1", planId: "plan-456" }));

      expect(store.getState().plan.error).toBe("Failed to rebuild plan");
    });
  });

  describe("fetchPlanChat thunk", () => {
    it("stores chat messages keyed by context on fulfilled", async () => {
      const messages = [
        { role: "user" as const, content: "hi", timestamp: "2025-01-01" },
        { role: "assistant" as const, content: "hello", timestamp: "2025-01-01" },
      ];
      vi.mocked(api.chat.history).mockResolvedValue({ messages });
      const store = createStore();
      await store.dispatch(
        fetchPlanChat({ projectId: "proj-1", context: "plan-plan-1" }),
      );

      expect(store.getState().plan.chatMessages["plan-plan-1"]).toEqual(messages);
      expect(api.chat.history).toHaveBeenCalledWith("proj-1", "plan-plan-1");
    });

    it("uses empty array when messages missing", async () => {
      vi.mocked(api.chat.history).mockResolvedValue({});
      const store = createStore();
      await store.dispatch(
        fetchPlanChat({ projectId: "proj-1", context: "plan-plan-2" }),
      );

      expect(store.getState().plan.chatMessages["plan-plan-2"]).toEqual([]);
    });

    it("stores messages for multiple contexts independently", async () => {
      vi.mocked(api.chat.history)
        .mockResolvedValueOnce({ messages: [{ role: "user", content: "a", timestamp: "1" }] })
        .mockResolvedValueOnce({ messages: [{ role: "user", content: "b", timestamp: "2" }] });
      const store = createStore();
      await store.dispatch(fetchPlanChat({ projectId: "proj-1", context: "plan-plan-a" }));
      await store.dispatch(fetchPlanChat({ projectId: "proj-1", context: "plan-plan-b" }));

      expect(store.getState().plan.chatMessages["plan-plan-a"]).toHaveLength(1);
      expect(store.getState().plan.chatMessages["plan-plan-b"]).toHaveLength(1);
    });
  });

  describe("sendPlanMessage thunk", () => {
    it("appends assistant message to chatMessages on fulfilled", async () => {
      vi.mocked(api.chat.send).mockResolvedValue({ message: "Here is my response" });
      const store = createStore();
      await store.dispatch(
        sendPlanMessage({
          projectId: "proj-1",
          message: "hello",
          context: "plan-plan-1",
        }),
      );

      const state = store.getState().plan;
      expect(state.chatMessages["plan-plan-1"]).toHaveLength(1);
      expect(state.chatMessages["plan-plan-1"][0].role).toBe("assistant");
      expect(state.chatMessages["plan-plan-1"][0].content).toBe("Here is my response");
      expect(api.chat.send).toHaveBeenCalledWith("proj-1", "hello", "plan-plan-1");
    });

    it("creates context array if not present", async () => {
      vi.mocked(api.chat.send).mockResolvedValue({ message: "Response" });
      const store = createStore();
      await store.dispatch(
        sendPlanMessage({
          projectId: "proj-1",
          message: "hi",
          context: "plan-new-context",
        }),
      );

      expect(store.getState().plan.chatMessages["plan-new-context"]).toHaveLength(1);
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.chat.send).mockRejectedValue(new Error("Send failed"));
      const store = createStore();
      await store.dispatch(
        sendPlanMessage({
          projectId: "proj-1",
          message: "hello",
          context: "plan-plan-1",
        }),
      );

      expect(store.getState().plan.error).toBe("Send failed");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.chat.send).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(
        sendPlanMessage({
          projectId: "proj-1",
          message: "hello",
          context: "plan-plan-1",
        }),
      );

      expect(store.getState().plan.error).toBe("Failed to send message");
    });
  });

  describe("fetchSinglePlan thunk", () => {
    it("updates plan in plans array when found", async () => {
      const updatedPlan: Plan = {
        ...mockPlan,
        content: "# Updated content",
        status: "building",
      };
      vi.mocked(api.plans.get).mockResolvedValue(updatedPlan);
      const store = createStore();
      store.dispatch(setPlansAndGraph({ plans: [mockPlan], dependencyGraph: mockGraph }));

      await store.dispatch(fetchSinglePlan({ projectId: "proj-1", planId: "plan-1" }));

      const state = store.getState().plan;
      expect(state.plans[0].content).toBe("# Updated content");
      expect(state.plans[0].status).toBe("building");
      expect(api.plans.get).toHaveBeenCalledWith("proj-1", "plan-1");
    });

    it("does not add plan when not in array", async () => {
      const otherPlan: Plan = {
        ...mockPlan,
        metadata: { ...mockPlan.metadata, planId: "plan-other" },
      };
      vi.mocked(api.plans.get).mockResolvedValue(otherPlan);
      const store = createStore();
      store.dispatch(setPlansAndGraph({ plans: [mockPlan], dependencyGraph: mockGraph }));

      await store.dispatch(fetchSinglePlan({ projectId: "proj-1", planId: "plan-other" }));

      expect(store.getState().plan.plans).toHaveLength(1);
      expect(store.getState().plan.plans[0].metadata.planId).toBe("plan-1");
    });
  });

  describe("archivePlan thunk", () => {
    it("sets archivingPlanId on pending", async () => {
      let resolveApi: (v: Plan) => void;
      const apiPromise = new Promise<Plan>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.plans.archive).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        archivePlan({ projectId: "proj-1", planId: "plan-123" }),
      );

      expect(store.getState().plan.archivingPlanId).toBe("plan-123");

      resolveApi!(mockPlan);
      await dispatchPromise;
    });

    it("clears archivingPlanId on fulfilled", async () => {
      vi.mocked(api.plans.archive).mockResolvedValue(mockPlan);
      const store = createStore();
      await store.dispatch(archivePlan({ projectId: "proj-1", planId: "plan-123" }));

      expect(store.getState().plan.archivingPlanId).toBeNull();
      expect(api.plans.archive).toHaveBeenCalledWith("proj-1", "plan-123");
    });

    it("clears archivingPlanId and sets error on rejected", async () => {
      vi.mocked(api.plans.archive).mockRejectedValue(new Error("Archive failed"));
      const store = createStore();
      await store.dispatch(archivePlan({ projectId: "proj-1", planId: "plan-123" }));

      const state = store.getState().plan;
      expect(state.archivingPlanId).toBeNull();
      expect(state.error).toBe("Archive failed");
    });
  });
});
