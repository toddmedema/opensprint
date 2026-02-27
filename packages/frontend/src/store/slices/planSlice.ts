import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { Plan, PlanDependencyGraph, PlanStatusResponse } from "@opensprint/shared";
import { api } from "../../api/client";
import { DEDUP_SKIP } from "../dedup";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export type FetchPlansArg = string | { projectId: string; background?: boolean };

/** Number of in-flight fetchPlans requests; used to skip duplicate calls (skip when > 1). */
const PLANS_IN_FLIGHT_KEY = "plansInFlightCount" as const;

export interface PlanState {
  plans: Plan[];
  dependencyGraph: PlanDependencyGraph | null;
  selectedPlanId: string | null;
  chatMessages: Record<string, Message[]>;
  loading: boolean;
  [PLANS_IN_FLIGHT_KEY]: number;
  decomposing: boolean;
  /** Whether a plan is currently being generated from a feature description */
  generating: boolean;
  /** Plan status for Dream CTA (plan/replan/none) */
  planStatus: PlanStatusResponse | null;
  /** Plan ID currently being executed (Execute!) — for loading state */
  executingPlanId: string | null;
  /** Plan ID currently being re-executed (Re-execute) — for loading state */
  reExecutingPlanId: string | null;
  /** Plan ID currently being archived — for loading state */
  archivingPlanId: string | null;
  /** Plan ID currently being deleted — for loading state */
  deletingPlanId: string | null;
  /** Plan IDs currently queued or active for plan-tasks (AI generate tasks) — for loading state */
  planTasksPlanIds: string[];
  /** Optimistic plan cards shown immediately on Generate Plan click (title = first 30 chars, tempId for matching) */
  optimisticPlans: Array<{ tempId: string; title: string }>;
  error: string | null;
  /** Per-plan error for Execute! failures (shown inline on the card) */
  executeError: { planId: string; message: string } | null;
  /** Unobtrusive toast for background refresh failures (does not reset page) */
  backgroundError: string | null;
}

const initialState: PlanState = {
  plans: [],
  dependencyGraph: null,
  selectedPlanId: null,
  chatMessages: {},
  loading: false,
  [PLANS_IN_FLIGHT_KEY]: 0,
  decomposing: false,
  generating: false,
  planStatus: null,
  executingPlanId: null,
  reExecutingPlanId: null,
  archivingPlanId: null,
  deletingPlanId: null,
  planTasksPlanIds: [],
  optimisticPlans: [],
  error: null,
  executeError: null,
  backgroundError: null,
};

export const fetchPlanStatus = createAsyncThunk(
  "plan/fetchPlanStatus",
  async (projectId: string): Promise<PlanStatusResponse> => {
    return api.projects.getPlanStatus(projectId);
  }
);

export const fetchPlans = createAsyncThunk<
  { plans: Plan[]; dependencyGraph: PlanDependencyGraph; background: boolean },
  FetchPlansArg
>("plan/fetchPlans", async (arg: FetchPlansArg, { getState, rejectWithValue }) => {
  const root = getState() as { plan: PlanState };
  if (root.plan[PLANS_IN_FLIGHT_KEY] > 1) {
    return rejectWithValue(DEDUP_SKIP) as never;
  }
  const projectId = typeof arg === "string" ? arg : arg.projectId;
  const graph = await api.plans.list(projectId);
  return {
    plans: graph.plans,
    dependencyGraph: graph,
    background: typeof arg === "string" ? false : (arg.background ?? false),
  };
});

export const decomposePlans = createAsyncThunk("plan/decompose", async (projectId: string) => {
  await api.plans.decompose(projectId);
});

export interface GeneratePlanArg {
  projectId: string;
  description: string;
  /** Optional tempId to match optimistic plan for replacement on fulfilled/rejected */
  tempId?: string;
}

export const generatePlan = createAsyncThunk(
  "plan/generate",
  async ({ projectId, description }: GeneratePlanArg) => {
    return api.plans.generate(projectId, { description });
  }
);

export const executePlan = createAsyncThunk(
  "plan/execute",
  async ({
    projectId,
    planId,
    prerequisitePlanIds,
  }: {
    projectId: string;
    planId: string;
    prerequisitePlanIds?: string[];
  }) => {
    await api.plans.execute(projectId, planId, prerequisitePlanIds);
  }
);

export const generateTasksForPlan = createAsyncThunk(
  "plan/generateTasks",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    return api.plans.planTasks(projectId, planId);
  }
);

export const reExecutePlan = createAsyncThunk(
  "plan/reExecute",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    await api.plans.reExecute(projectId, planId);
  }
);

export const planTasks = createAsyncThunk(
  "plan/planTasks",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    return api.plans.planTasks(projectId, planId);
  }
);

export const archivePlan = createAsyncThunk(
  "plan/archive",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    return api.plans.archive(projectId, planId);
  }
);

export const deletePlan = createAsyncThunk(
  "plan/delete",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    await api.plans.delete(projectId, planId);
  }
);

/** Normalize API messages to our Message shape (role, content, timestamp). */
function normalizeMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is { role: string; content: string; timestamp?: string } =>
        m != null &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString(),
    }));
}

export interface FetchPlanChatArg {
  projectId: string;
  context: string;
  /** When true, always replace Redux state with server data (e.g. after send). */
  forceReplace?: boolean;
}

export const fetchPlanChat = createAsyncThunk(
  "plan/fetchChat",
  async ({ projectId, context }: FetchPlanChatArg) => {
    if (!context?.trim()) {
      return { context: context || "", messages: [] };
    }
    const conv = await api.chat.history(projectId, context);
    const messages = normalizeMessages(conv?.messages ?? []);
    return { context, messages };
  }
);

export const sendPlanMessage = createAsyncThunk(
  "plan/sendMessage",
  async ({
    projectId,
    message,
    context,
  }: {
    projectId: string;
    message: string;
    context: string;
  }) => {
    if (!context?.trim()) {
      throw new Error("Plan chat context is required");
    }
    const response = await api.chat.send(projectId, message, context);
    return { context, response };
  }
);

export const fetchSinglePlan = createAsyncThunk(
  "plan/fetchSingle",
  async ({ projectId, planId }: { projectId: string; planId: string }) => {
    return api.plans.get(projectId, planId);
  }
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
  }
);

export const createPlan = createAsyncThunk(
  "plan/create",
  async ({ projectId, data }: { projectId: string; data: { title: string; content: string } }) => {
    return api.plans.create(projectId, data);
  }
);

const planSlice = createSlice({
  name: "plan",
  initialState,
  reducers: {
    setSelectedPlanId(state, action: PayloadAction<string | null>) {
      state.selectedPlanId = action.payload;
    },
    /** Sync from TanStack Query usePlanStatus. */
    setPlanStatusPayload(state, action: PayloadAction<PlanStatusResponse | null>) {
      state.planStatus = action.payload;
    },
    addPlanLocally(state, action: PayloadAction<Plan>) {
      state.plans.push(action.payload);
    },
    setPlanError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setExecutingPlanId(state, action: PayloadAction<string | null>) {
      state.executingPlanId = action.payload;
      if (action.payload) {
        state.executeError = null;
      }
    },
    clearExecuteError(state) {
      state.executeError = null;
    },
    clearPlanBackgroundError(state) {
      state.backgroundError = null;
    },
    setPlansAndGraph(
      state,
      action: PayloadAction<{ plans: Plan[]; dependencyGraph: PlanDependencyGraph | null }>
    ) {
      state.plans = action.payload.plans;
      state.dependencyGraph = action.payload.dependencyGraph;
    },
    enqueuePlanTasksId(state, action: PayloadAction<string>) {
      if (!state.planTasksPlanIds.includes(action.payload)) {
        state.planTasksPlanIds.push(action.payload);
      }
    },
    addOptimisticPlan(state, action: PayloadAction<{ tempId: string; title: string }>) {
      state.optimisticPlans.push(action.payload);
    },
    removeOptimisticPlan(state, action: PayloadAction<string>) {
      state.optimisticPlans = state.optimisticPlans.filter((p) => p.tempId !== action.payload);
    },
    /** Sync from TanStack Query usePlanChat. */
    setPlanChatMessages(
      state,
      action: PayloadAction<{ context: string; messages: { role: "user" | "assistant"; content: string; timestamp: string }[] }>
    ) {
      const { context, messages } = action.payload;
      if (context?.trim()) state.chatMessages[context] = messages;
    },
    /** Sync from TanStack Query useSinglePlan (merge one plan into list). */
    setSinglePlan(state, action: PayloadAction<Plan>) {
      const idx = state.plans.findIndex(
        (p) => p.metadata.planId === action.payload.metadata.planId
      );
      if (idx >= 0) {
        state.plans[idx] = action.payload;
      }
    },
    resetPlan() {
      return { ...initialState };
    },
  },
  extraReducers: (builder) => {
    builder
      // fetchPlanStatus
      .addCase(fetchPlanStatus.fulfilled, (state, action) => {
        state.planStatus = action.payload;
      })
      // createPlan
      .addCase(createPlan.fulfilled, (state, action) => {
        state.plans.push(action.payload);
      })
      // fetchPlans
      .addCase(fetchPlans.pending, (state, action) => {
        state[PLANS_IN_FLIGHT_KEY] = (state[PLANS_IN_FLIGHT_KEY] ?? 0) + 1;
        const background = typeof action.meta.arg !== "string" && action.meta.arg.background;
        if (!background) {
          state.loading = true;
          state.error = null;
        }
      })
      .addCase(fetchPlans.fulfilled, (state, action) => {
        state.plans = action.payload.plans;
        state.dependencyGraph = action.payload.dependencyGraph;
        state.loading = false;
        state.backgroundError = null;
        state[PLANS_IN_FLIGHT_KEY] = Math.max(0, (state[PLANS_IN_FLIGHT_KEY] ?? 1) - 1);
      })
      .addCase(fetchPlans.rejected, (state, action) => {
        state[PLANS_IN_FLIGHT_KEY] = Math.max(0, (state[PLANS_IN_FLIGHT_KEY] ?? 1) - 1);
        if (action.payload === DEDUP_SKIP) return;
        const background = typeof action.meta.arg !== "string" && action.meta.arg.background;
        state.loading = false;
        const msg = action.error.message || "Failed to load plans";
        if (background) {
          state.backgroundError = msg;
        } else {
          state.error = msg;
        }
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
        state.error = action.error.message || "Failed to decompose PRD";
      })
      // generatePlan — optimistic UX: no longer blocks input; optimistic plans replaced in place
      .addCase(generatePlan.pending, (state, action) => {
        state.generating = true;
        state.error = null;
      })
      .addCase(generatePlan.fulfilled, (state, action) => {
        state.generating = false;
        const tempId = action.meta.arg.tempId;
        if (tempId) {
          state.optimisticPlans = state.optimisticPlans.filter((p) => p.tempId !== tempId);
        }
        state.plans.push(action.payload);
      })
      .addCase(generatePlan.rejected, (state, action) => {
        state.generating = false;
        const tempId = action.meta.arg.tempId;
        if (tempId) {
          state.optimisticPlans = state.optimisticPlans.filter((p) => p.tempId !== tempId);
        }
        state.error = action.error.message || "Failed to generate plan";
      })
      // executePlan / reExecutePlan
      .addCase(executePlan.pending, (state, action) => {
        state.executingPlanId = action.meta.arg.planId;
        state.error = null;
      })
      .addCase(executePlan.fulfilled, (state) => {
        state.executingPlanId = null;
      })
      .addCase(executePlan.rejected, (state, action) => {
        const message = action.error.message || "Failed to start execute";
        state.executingPlanId = null;
        state.error = message;
        state.executeError = { planId: action.meta.arg.planId, message };
      })
      .addCase(generateTasksForPlan.pending, (state, action) => {
        if (!state.planTasksPlanIds.includes(action.meta.arg.planId)) {
          state.planTasksPlanIds.push(action.meta.arg.planId);
        }
        state.executeError = null;
      })
      .addCase(generateTasksForPlan.fulfilled, (state, action) => {
        state.planTasksPlanIds = state.planTasksPlanIds.filter(
          (id) => id !== action.payload.metadata.planId
        );
        const plan = action.payload;
        const idx = state.plans.findIndex((p) => p.metadata.planId === plan.metadata.planId);
        if (idx >= 0) state.plans[idx] = plan;
      })
      .addCase(generateTasksForPlan.rejected, (state, action) => {
        state.planTasksPlanIds = state.planTasksPlanIds.filter(
          (id) => id !== action.meta.arg.planId
        );
        const message = action.error.message || "Failed to generate tasks";
        state.executeError = {
          planId: action.meta.arg.planId,
          message,
        };
      })
      .addCase(reExecutePlan.pending, (state, action) => {
        state.reExecutingPlanId = action.meta.arg.planId;
        state.error = null;
      })
      .addCase(reExecutePlan.fulfilled, (state) => {
        state.reExecutingPlanId = null;
      })
      .addCase(reExecutePlan.rejected, (state, action) => {
        state.reExecutingPlanId = null;
        state.error = action.error.message || "Failed to re-execute plan";
      })
      // planTasks
      .addCase(planTasks.pending, (state, action) => {
        if (!state.planTasksPlanIds.includes(action.meta.arg.planId)) {
          state.planTasksPlanIds.push(action.meta.arg.planId);
        }
        state.error = null;
      })
      .addCase(planTasks.fulfilled, (state, action) => {
        state.planTasksPlanIds = state.planTasksPlanIds.filter(
          (id) => id !== action.payload.metadata.planId
        );
        if (state.executeError?.planId === action.payload.metadata.planId) {
          state.executeError = null;
        }
        const idx = state.plans.findIndex(
          (p) => p.metadata.planId === action.payload.metadata.planId
        );
        if (idx >= 0) {
          state.plans[idx] = action.payload;
        }
      })
      .addCase(planTasks.rejected, (state, action) => {
        state.planTasksPlanIds = state.planTasksPlanIds.filter(
          (id) => id !== action.meta.arg.planId
        );
        state.executeError = {
          planId: action.meta.arg.planId,
          message: action.error.message || "Failed to generate tasks",
        };
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
        state.error = action.error.message || "Failed to archive plan";
      })
      // deletePlan
      .addCase(deletePlan.pending, (state, action) => {
        state.deletingPlanId = action.meta.arg.planId;
        state.error = null;
      })
      .addCase(deletePlan.fulfilled, (state) => {
        state.deletingPlanId = null;
      })
      .addCase(deletePlan.rejected, (state, action) => {
        state.deletingPlanId = null;
        state.error = action.error.message || "Failed to delete plan";
      })
      // fetchPlanChat — don't overwrite if we have more messages locally (optimistic from sendPlanMessage)
      // Prevents race where stale fetch completes after user sends and wipes the optimistic message.
      // When forceReplace is true (e.g. refetch after send), always replace with server data.
      .addCase(fetchPlanChat.fulfilled, (state, action) => {
        const { context, messages } = action.payload;
        if (!context?.trim()) return;
        const forceReplace = (action.meta.arg as FetchPlanChatArg).forceReplace;
        const current = state.chatMessages[context] ?? [];
        if (forceReplace || messages.length >= current.length) {
          state.chatMessages[context] = messages;
        }
      })
      .addCase(fetchPlanChat.rejected, (state, action) => {
        // Surface fetch failure so user knows chat history didn't load; don't overwrite existing messages
        const msg = action.error.message || "Failed to load chat history";
        if (!state.backgroundError) {
          state.backgroundError = msg;
        }
      })
      // sendPlanMessage — add user message optimistically so it appears immediately
      .addCase(sendPlanMessage.pending, (state, action) => {
        const { context, message } = action.meta.arg;
        if (!state.chatMessages[context]) state.chatMessages[context] = [];
        state.chatMessages[context].push({
          role: "user",
          content: message,
          timestamp: new Date().toISOString(),
        });
      })
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
        // Rollback optimistic user message so UI reflects that send failed
        const { context } = action.meta.arg;
        const messages = state.chatMessages[context];
        if (messages?.length && messages[messages.length - 1]?.role === "user") {
          state.chatMessages[context] = messages.slice(0, -1);
        }
        state.error = action.error.message || "Failed to send message";
      })
      // fetchSinglePlan
      .addCase(fetchSinglePlan.fulfilled, (state, action) => {
        const idx = state.plans.findIndex(
          (p) => p.metadata.planId === action.payload.metadata.planId
        );
        if (idx >= 0) {
          state.plans[idx] = action.payload;
        }
      })
      // updatePlan
      .addCase(updatePlan.fulfilled, (state, action) => {
        const idx = state.plans.findIndex(
          (p) => p.metadata.planId === action.payload.metadata.planId
        );
        if (idx >= 0) {
          state.plans[idx] = action.payload;
        }
      });
  },
});

export const {
  setSelectedPlanId,
  addPlanLocally,
  setPlanError,
  setPlanStatusPayload,
  setExecutingPlanId,
  clearExecuteError,
  clearPlanBackgroundError,
  setPlansAndGraph,
  enqueuePlanTasksId,
  addOptimisticPlan,
  removeOptimisticPlan,
  setPlanChatMessages,
  setSinglePlan,
  resetPlan,
} = planSlice.actions;
export default planSlice.reducer;
