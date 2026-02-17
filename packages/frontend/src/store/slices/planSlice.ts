import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { Plan, PlanDependencyGraph, PlanStatusResponse } from "@opensprint/shared";
import { api } from "../../api/client";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface PlanState {
  plans: Plan[];
  dependencyGraph: PlanDependencyGraph | null;
  selectedPlanId: string | null;
  chatMessages: Record<string, Message[]>;
  loading: boolean;
  decomposing: boolean;
  /** Plan status for Dream CTA (plan/replan/none) */
  planStatus: PlanStatusResponse | null;
  /** Plan ID currently being shipped (Build It!) — for loading state */
  shippingPlanId: string | null;
  /** Plan ID currently being reshipped (Rebuild) — for loading state */
  reshippingPlanId: string | null;
  /** Plan ID currently being archived — for loading state */
  archivingPlanId: string | null;
  error: string | null;
}

const initialState: PlanState = {
  plans: [],
  dependencyGraph: null,
  selectedPlanId: null,
  chatMessages: {},
  loading: false,
  decomposing: false,
  planStatus: null,
  shippingPlanId: null,
  reshippingPlanId: null,
  archivingPlanId: null,
  error: null,
};

export const fetchPlanStatus = createAsyncThunk(
  "plan/fetchPlanStatus",
  async (projectId: string): Promise<PlanStatusResponse> => {
    return api.projects.getPlanStatus(projectId);
  },
);

export const fetchPlans = createAsyncThunk("plan/fetchPlans", async (projectId: string) => {
  const graph = await api.plans.list(projectId);
  return {
    plans: graph.plans,
    dependencyGraph: graph,
  };
});

export const decomposePlans = createAsyncThunk("plan/decompose", async (projectId: string) => {
  await api.plans.decompose(projectId);
});

export const shipPlan = createAsyncThunk(
  "plan/ship",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    await api.plans.ship(projectId, planId);
  },
);

export const reshipPlan = createAsyncThunk(
  "plan/reship",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    await api.plans.reship(projectId, planId);
  },
);

export const archivePlan = createAsyncThunk(
  "plan/archive",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    return api.plans.archive(projectId, planId);
  },
);

export const fetchPlanChat = createAsyncThunk(
  "plan/fetchChat",
  async ({ projectId, context }: { projectId: string; context: string }) => {
    const conv = await api.chat.history(projectId, context);
    return { context, messages: conv?.messages ?? [] };
  },
);

export const sendPlanMessage = createAsyncThunk(
  "plan/sendMessage",
  async ({ projectId, message, context }: { projectId: string; message: string; context: string }) => {
    const response = await api.chat.send(projectId, message, context);
    return { context, response };
  },
);

export const fetchSinglePlan = createAsyncThunk(
  "plan/fetchSingle",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    return api.plans.get(projectId, planId);
  },
);

export const updatePlan = createAsyncThunk(
  "plan/update",
  async ({
    projectId,
    planId,
    content,
  }: {
    projectId: string;
    planId: string;
    content: string;
  }) => {
    return api.plans.update(projectId, planId, { content });
  },
);

const planSlice = createSlice({
  name: "plan",
  initialState,
  reducers: {
    setSelectedPlanId(state, action: PayloadAction<string | null>) {
      state.selectedPlanId = action.payload;
    },
    addPlanLocally(state, action: PayloadAction<Plan>) {
      state.plans.push(action.payload);
    },
    setPlanError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setPlansAndGraph(
      state,
      action: PayloadAction<{ plans: Plan[]; dependencyGraph: PlanDependencyGraph | null }>,
    ) {
      state.plans = action.payload.plans;
      state.dependencyGraph = action.payload.dependencyGraph;
    },
    resetPlan() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      // fetchPlanStatus
      .addCase(fetchPlanStatus.fulfilled, (state, action) => {
        state.planStatus = action.payload;
      })
      // fetchPlans
      .addCase(fetchPlans.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchPlans.fulfilled, (state, action) => {
        state.plans = action.payload.plans;
        state.dependencyGraph = action.payload.dependencyGraph;
        state.loading = false;
      })
      .addCase(fetchPlans.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? "Failed to load plans";
      })
      // decomposePlans
      .addCase(decomposePlans.pending, (state) => {
        state.decomposing = true;
        state.error = null;
      })
      .addCase(decomposePlans.fulfilled, (state) => {
        state.decomposing = false;
      })
      .addCase(decomposePlans.rejected, (state, action) => {
        state.decomposing = false;
        state.error = action.error.message ?? "Failed to decompose PRD";
      })
      // shipPlan / reshipPlan
      .addCase(shipPlan.pending, (state, action) => {
        state.shippingPlanId = action.meta.arg.planId;
        state.error = null;
      })
      .addCase(shipPlan.fulfilled, (state) => {
        state.shippingPlanId = null;
      })
      .addCase(shipPlan.rejected, (state, action) => {
        state.shippingPlanId = null;
        state.error = action.error.message ?? "Failed to start build";
      })
      .addCase(reshipPlan.pending, (state, action) => {
        state.reshippingPlanId = action.meta.arg.planId;
        state.error = null;
      })
      .addCase(reshipPlan.fulfilled, (state) => {
        state.reshippingPlanId = null;
      })
      .addCase(reshipPlan.rejected, (state, action) => {
        state.reshippingPlanId = null;
        state.error = action.error.message ?? "Failed to rebuild plan";
      })
      // archivePlan
      .addCase(archivePlan.pending, (state, action) => {
        state.archivingPlanId = action.meta.arg.planId;
        state.error = null;
      })
      .addCase(archivePlan.fulfilled, (state) => {
        state.archivingPlanId = null;
      })
      .addCase(archivePlan.rejected, (state, action) => {
        state.archivingPlanId = null;
        state.error = action.error.message ?? "Failed to archive plan";
      })
      // fetchPlanChat
      .addCase(fetchPlanChat.fulfilled, (state, action) => {
        state.chatMessages[action.payload.context] = action.payload.messages;
      })
      // sendPlanMessage
      .addCase(sendPlanMessage.fulfilled, (state, action) => {
        const { context, response } = action.payload;
        if (!state.chatMessages[context]) state.chatMessages[context] = [];
        state.chatMessages[context].push({
          role: "assistant",
          content: response.message,
          timestamp: new Date().toISOString(),
        });
      })
      .addCase(sendPlanMessage.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to send message";
      })
      // fetchSinglePlan
      .addCase(fetchSinglePlan.fulfilled, (state, action) => {
        const idx = state.plans.findIndex((p) => p.metadata.planId === action.payload.metadata.planId);
        if (idx >= 0) {
          state.plans[idx] = action.payload;
        }
      })
      // updatePlan
      .addCase(updatePlan.fulfilled, (state, action) => {
        const idx = state.plans.findIndex((p) => p.metadata.planId === action.payload.metadata.planId);
        if (idx >= 0) {
          state.plans[idx] = action.payload;
        }
      });
  },
});

export const { setSelectedPlanId, addPlanLocally, setPlanError, setPlansAndGraph, resetPlan } = planSlice.actions;
export default planSlice.reducer;
