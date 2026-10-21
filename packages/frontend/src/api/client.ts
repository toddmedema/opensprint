import type {
  GlobalSettingsPutRequest,
  GlobalSettingsResponse,
  Project,
  CreateProjectRequest,
  ScaffoldProjectRequest,
  ScaffoldProjectResponse,
  UpdateProjectRequest,
  ProjectSettings,
  ProjectSettingsApiUpdate,
  Prd,
  PrdChangeLogEntry,
  PrdSectionUpdateResult,
  PrdUploadResult,
  Plan,
  PlanDependencyGraph,
  PlanStatusResponse,
  CreatePlanRequest,
  UpdatePlanRequest,
  GeneratePlanRequest,
  GeneratePlanResult,
  CrossEpicDependenciesResponse,
  PlanExecuteBatchItem,
  PlanExecuteBatchStatus,
  AuditorRun,
  Task,
  AgentSession,
  OrchestratorStatus,
  FeedbackItem,
  ChatRequest,
  ChatResponse,
  Conversation,
  ActiveAgent,
  TaskExecutionDiagnostics,
  Notification,
  DeploymentRecord,
  DeploymentConfig,
  ExpoReadinessResponse,
  HelpChatRequest,
  HelpChatResponse,
  HelpChatHistory,
  TaskAnalytics,
  AgentLogEntry,
  ExecuteTaskContext,
  EnvRuntimeResponse,
  PlanVersionSummary,
  PlanVersionContent,
  PlanHierarchyResponse,
  OpenEditorResponse,
  AgentChatHistoryResponse,
  AgentChatSupportResponse,
  TodoistIntegrationStatus,
  TodoistOAuthStartResponse,
  TodoistProjectInfo,
  TodoistProjectSelectionRequest,
  TodoistSyncResult,
  IntegrationStatusResponse,
  IntegrationSourceOption,
  IntegrationSyncResponse,
  GitHubConnectRequest,
  GitHubRepoSelectionRequest,
  IntakeItem,
  CommandInterpretation,
  CommandIntent,
  CommandPreview,
  CommandExecutionResult,
} from "@opensprint/shared";
import type { TaskListResponse } from "./taskList";
import type { PrdProposedDiffResponse, PrdVersionDiffResponse } from "./prdDiffTypes";

export type SelfImprovementStatusValue =
  | "idle"
  | "running_audit"
  | "running_experiments"
  | "awaiting_approval";

export type SelfImprovementStage =
  | "collecting_replay_cases"
  | "generating_candidate"
  | "replaying"
  | "scoring"
  | "promoting";

export interface CandidateDiffEntry {
  section: string;
  before: string;
  after: string;
}

export interface SelfImprovementMetrics {
  taskSuccessRate: number;
  retryRate?: number;
  reviewPassRate?: number;
  avgLatencyMs?: number;
  avgCostUsd?: number;
}

export interface SelfImprovementStatusSnapshot {
  status: SelfImprovementStatusValue;
  stage?: SelfImprovementStage;
  pendingCandidateId?: string;
  summary?: string;
  candidateDiff?: CandidateDiffEntry[];
  replaySampleSize?: number;
  baselineMetrics?: SelfImprovementMetrics;
  candidateMetrics?: SelfImprovementMetrics;
}

export type SelfImprovementRunMode = "audit_only" | "audit_and_experiments";

export type SelfImprovementRunOutcome =
  | "no_changes"
  | "tasks_created"
  | "candidate_rejected"
  | "promotion_pending"
  | "promoted"
  | "failed";

export interface SelfImprovementBehaviorStatus {
  pendingCandidateId?: string;
  activeBehaviorVersionId?: string;
  behaviorVersions: Array<{ id: string; promotedAt: string }>;
  history: Array<{
    timestamp: string;
    action: "approved" | "rejected" | "rollback";
    behaviorVersionId?: string;
    candidateId?: string;
  }>;
}

export interface SelfImprovementHistoryEntry {
  timestamp: string;
  status: string;
  tasksCreatedCount: number;
  mode: SelfImprovementRunMode;
  outcome: SelfImprovementRunOutcome;
  summary: string;
  runId?: string;
  promotedVersionId?: string;
  pendingCandidateId?: string;
}

/** API base; set VITE_API_BASE for production/staging (e.g. empty for same-origin, or full origin). */
const BASE_URL = `${(import.meta.env.VITE_API_BASE as string | undefined) ?? ""}/api/v1`;

/** Default upper bound for how long any API `fetch` may stay pending before aborting. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const NO_REQUEST_TIMEOUT = { timeoutMs: null } as const;

interface RequestOptions extends RequestInit {
  timeoutMs?: number | null;
}

/** Abort when either the timeout elapses or the caller's signal aborts (whichever comes first). */
function mergeRequestSignal(
  timeoutMs: number | null | undefined,
  userSignal?: AbortSignal | null
): AbortSignal | undefined {
  if (timeoutMs == null) return userSignal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (userSignal == null) return timeoutSignal;
  return AbortSignal.any([timeoutSignal, userSignal]);
}

/** Error thrown by request() when response is not ok; carries backend code, message, and optional details. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function isDatabaseUnavailableError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === "DATABASE_UNAVAILABLE";
}

/** True when fetch failed before getting a response (network down, CORS, server unreachable). */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  const msg =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message)
        : String(err);
  return (
    msg === "Failed to fetch" ||
    msg === "NetworkError" ||
    msg === "Network request failed" ||
    msg.includes("Load failed")
  );
}

/** Bearer for local API (desktop-injected script or dev); omit when unset. */
function getLocalSessionAuthHeaders(): Record<string, string> {
  const sessionToken =
    typeof window !== "undefined" ? window.__OPENSPRINT_LOCAL_SESSION__ : undefined;
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

/** Generic fetch wrapper with typed responses */
export async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const signal = mergeRequestSignal(timeoutMs, fetchOptions.signal);

  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      ...getLocalSessionAuthHeaders(),
      ...fetchOptions.headers,
    },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const code = body?.error?.code ?? "UNKNOWN";
    const message = body?.error?.message || response.statusText || "Request failed";
    const details = body?.error?.details ?? body?.error;
    throw new ApiError(message, code, details);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const result = await response.json();
  return result.data;
}

// ─── Models ───
export interface ModelOption {
  id: string;
  displayName: string;
}

// ─── DB Status ───
export interface DbStatusResponse {
  ok: boolean;
  message?: string;
  state: "connected" | "connecting" | "disconnected";
  lastCheckedAt: string | null;
}

// ─── Projects ───

export const api = {
  dbStatus: {
    get: (signal?: AbortSignal) =>
      request<DbStatusResponse>("/db-status", signal ? { signal } : {}),
  },
  models: {
    list: (provider: string, projectId?: string, baseUrl?: string) => {
      const params = new URLSearchParams({ provider });
      if (projectId) params.set("projectId", projectId);
      if ((provider === "lmstudio" || provider === "ollama") && baseUrl) {
        params.set("baseUrl", baseUrl);
      }
      return request<ModelOption[]>(`/models?${params.toString()}`);
    },
  },
  globalSettings: {
    get: () => request<GlobalSettingsResponse>("/global-settings"),
    put: (updates: GlobalSettingsPutRequest) =>
      request<GlobalSettingsResponse>("/global-settings", {
        method: "PUT",
        body: JSON.stringify(updates),
      }),
    revealKey: (provider: string, id: string) =>
      request<{ value: string }>(
        `/global-settings/reveal-key/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`
      ),
    clearLimitHit: (provider: string, id: string) =>
      request<GlobalSettingsResponse>(
        `/global-settings/clear-limit-hit/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`,
        {
          method: "POST",
        }
      ),
    revealTodoistSecret: () => request<{ value: string }>("/global-settings/reveal-todoist-secret"),
    setupTables: (databaseUrl: string) =>
      request<{ ok: boolean }>("/global-settings/setup-tables", {
        method: "POST",
        body: JSON.stringify({ databaseUrl }),
      }),
    migrateToPostgres: (databaseUrl: string) =>
      request<{ ok: boolean; message: string }>("/global-settings/migrate-to-postgres", {
        method: "POST",
        body: JSON.stringify({ databaseUrl }),
      }),
  },
  env: {
    getRuntime: () => request<EnvRuntimeResponse>("/env/runtime"),
    getPrerequisites: () => request<{ missing: string[]; platform: string }>("/env/prerequisites"),
    getKeys: () =>
      request<{
        anthropic: boolean;
        cursor: boolean;
        openai: boolean;
        google: boolean;
        claudeCli: boolean;
        cursorCli: boolean;
        ollamaCli: boolean;
        useCustomCli: boolean;
      }>("/env/keys"),
    installCursorCli: () =>
      request<{
        success: boolean;
        message: string;
        installUrl: string;
        manualCommand: string;
        platform: string;
      }>("/env/cursor-cli-install", {
        method: "POST",
      }),
    getGlobalStatus: () =>
      request<{ hasAnyKey: boolean; useCustomCli: boolean }>("/env/global-status"),
    validateKey: (provider: "claude" | "cursor" | "openai" | "google", value: string) =>
      request<{ valid: boolean; error?: string }>("/env/keys/validate", {
        method: "POST",
        body: JSON.stringify({ provider, value }),
      }),
    saveKey: (
      key: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY",
      value: string
    ) =>
      request<{ saved: boolean }>("/env/keys", {
        method: "POST",
        body: JSON.stringify({ key, value }),
      }),
    setGlobalSettings: (updates: { useCustomCli?: boolean }) =>
      request<{ useCustomCli: boolean }>("/env/global-settings", {
        method: "PUT",
        body: JSON.stringify(updates),
      }),
  },
  projects: {
    list: (signal?: AbortSignal) => request<Project[]>("/projects", signal ? { signal } : {}),
    get: (id: string) => request<Project>(`/projects/${id}`),
    getPlanStatus: (id: string) => request<PlanStatusResponse>(`/projects/${id}/plan-status`),
    getSketchContext: (id: string) =>
      request<{ hasExistingCode: boolean }>(`/projects/${id}/sketch-context`),
    create: (data: CreateProjectRequest) =>
      request<Project>("/projects", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    scaffold: (data: ScaffoldProjectRequest) =>
      request<ScaffoldProjectResponse>("/projects/scaffold", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: UpdateProjectRequest) =>
      request<Project>(`/projects/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    getSettings: (id: string) => request<ProjectSettings>(`/projects/${id}/settings`),
    updateSettings: (id: string, data: ProjectSettingsApiUpdate) =>
      request<ProjectSettings>(`/projects/${id}/settings`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    runSelfImprovement: (id: string) =>
      request<{ tasksCreated: number; runId?: string; skipped?: string }>(
        `/projects/${id}/self-improvement/run`,
        { method: "POST" }
      ),
    getSelfImprovementStatus: (id: string) =>
      request<SelfImprovementStatusSnapshot>(`/projects/${id}/self-improvement/status`),
    getSelfImprovementHistory: (id: string, limit?: number) =>
      request<SelfImprovementHistoryEntry[]>(
        `/projects/${id}/self-improvement/history${limit != null ? `?limit=${limit}` : ""}`
      ),
    approveSelfImprovement: (id: string, candidateId?: string) =>
      request<SelfImprovementBehaviorStatus>(`/projects/${id}/self-improvement/approve`, {
        method: "POST",
        ...(candidateId ? { body: JSON.stringify({ candidateId }) } : {}),
      }),
    rejectSelfImprovement: (id: string, candidateId?: string) =>
      request<SelfImprovementBehaviorStatus>(`/projects/${id}/self-improvement/reject`, {
        method: "POST",
        ...(candidateId ? { body: JSON.stringify({ candidateId }) } : {}),
      }),
    rollbackSelfImprovement: (id: string, body: { behaviorVersionId: string }) =>
      request<SelfImprovementBehaviorStatus>(`/projects/${id}/self-improvement/rollback`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    archive: (id: string) => request<void>(`/projects/${id}/archive`, { method: "POST" }),
    delete: (id: string) =>
      request<void>(`/projects/${id}`, {
        method: "DELETE",
      }),
    getAgentsInstructions: (id: string) =>
      request<{ content: string }>(`/projects/${id}/agents/instructions`),
    updateAgentsInstructions: (id: string, content: string) =>
      request<{ saved: boolean }>(`/projects/${id}/agents/instructions`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      }),
    getAgentsInstructionsForRole: (id: string, role: string) =>
      request<{ content: string }>(`/projects/${id}/agents/instructions/${role}`),
    updateAgentsInstructionsForRole: (id: string, role: string, content: string) =>
      request<{ saved: boolean }>(`/projects/${id}/agents/instructions/${role}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      }),
  },

  // ─── PRD ───
  prd: {
    get: (projectId: string) => request<Prd>(`/projects/${projectId}/prd`),
    updateSection: (
      projectId: string,
      section: string,
      content: string,
      expectedVersion?: number
    ) =>
      request<PrdSectionUpdateResult>(`/projects/${projectId}/prd/${section}`, {
        method: "PUT",
        body: JSON.stringify({
          content,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        }),
      }),
    getHistory: (projectId: string) =>
      request<PrdChangeLogEntry[]>(`/projects/${projectId}/prd/history`),
    getProposedDiff: (
      projectId: string,
      requestId: string,
      opts?: { includeContent?: boolean; lineOffset?: number; lineLimit?: number }
    ) => {
      const params = new URLSearchParams({ requestId });
      if (opts?.includeContent === false) params.set("includeContent", "false");
      if (opts?.lineOffset != null) params.set("lineOffset", String(opts.lineOffset));
      if (opts?.lineLimit != null) params.set("lineLimit", String(opts.lineLimit));
      return request<PrdProposedDiffResponse>(
        `/projects/${projectId}/prd/proposed-diff?${params.toString()}`
      );
    },
    getVersionDiff: (
      projectId: string,
      fromVersion: string,
      toVersion?: string,
      opts?: { includeContent?: boolean; lineOffset?: number; lineLimit?: number }
    ) => {
      const params = new URLSearchParams({ fromVersion });
      if (toVersion != null && toVersion !== "") params.set("toVersion", toVersion);
      if (opts?.includeContent === false) params.set("includeContent", "false");
      if (opts?.lineOffset != null) params.set("lineOffset", String(opts.lineOffset));
      if (opts?.lineLimit != null) params.set("lineLimit", String(opts.lineLimit));
      return request<PrdVersionDiffResponse>(
        `/projects/${projectId}/prd/diff?${params.toString()}`
      );
    },
    upload: async (projectId: string, file: File): Promise<PrdUploadResult> => {
      const formData = new FormData();
      formData.append("file", file);
      const url = `${BASE_URL}/projects/${projectId}/prd/upload`;
      const response = await fetch(url, {
        method: "POST",
        body: formData,
        headers: {
          ...getLocalSessionAuthHeaders(),
        },
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({
          error: { code: "UNKNOWN", message: response.statusText },
        }));
        throw new Error(error.error?.message ?? "Upload failed");
      }
      const result = await response.json();
      return result.data as PrdUploadResult;
    },
    generateFromCodebase: (projectId: string) =>
      request<void>(`/projects/${projectId}/prd/generate-from-codebase`, {
        method: "POST",
        ...NO_REQUEST_TIMEOUT,
      }),
  },

  // ─── Plans ───
  plans: {
    list: (projectId: string) => request<PlanDependencyGraph>(`/projects/${projectId}/plans`),
    decompose: (projectId: string) =>
      request<{ created: number; plans: Plan[] }>(`/projects/${projectId}/plans/decompose`, {
        method: "POST",
        ...NO_REQUEST_TIMEOUT,
      }),
    generate: (projectId: string, data: GeneratePlanRequest) =>
      request<GeneratePlanResult>(`/projects/${projectId}/plans/generate`, {
        method: "POST",
        body: JSON.stringify(data),
        ...NO_REQUEST_TIMEOUT,
      }),
    get: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}`),
    getHierarchy: (projectId: string, planId: string) =>
      request<PlanHierarchyResponse>(`/projects/${projectId}/plans/${planId}/hierarchy`),
    listVersions: async (projectId: string, planId: string) => {
      const res = await request<{ versions: PlanVersionSummary[] }>(
        `/projects/${projectId}/plans/${planId}/versions`
      );
      return res.versions;
    },
    getVersion: (projectId: string, planId: string, versionNumber: number) =>
      request<PlanVersionContent>(
        `/projects/${projectId}/plans/${planId}/versions/${versionNumber}`
      ),
    create: (projectId: string, data: CreatePlanRequest) =>
      request<Plan>(`/projects/${projectId}/plans`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (projectId: string, planId: string, data: UpdatePlanRequest) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    getCrossEpicDependencies: (projectId: string, planId: string) =>
      request<CrossEpicDependenciesResponse>(
        `/projects/${projectId}/plans/${planId}/cross-epic-dependencies`
      ),
    auditorRuns: (projectId: string, planId: string) =>
      request<AuditorRun[]>(`/projects/${projectId}/plans/${planId}/auditor-runs`),
    planTasks: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/plan-tasks`, {
        method: "POST",
        ...NO_REQUEST_TIMEOUT,
      }),
    execute: (
      projectId: string,
      planId: string,
      options?: { prerequisitePlanIds?: string[]; version_number?: number }
    ) => {
      const body: { prerequisitePlanIds?: string[]; version_number?: number } = {};
      if (options?.prerequisitePlanIds?.length)
        body.prerequisitePlanIds = options.prerequisitePlanIds;
      if (options?.version_number != null) body.version_number = options.version_number;
      return request<Plan>(`/projects/${projectId}/plans/${planId}/execute`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    executeBatch: (projectId: string, body: { items: PlanExecuteBatchItem[] }) =>
      request<{ batchId: string }>(`/projects/${projectId}/plans/execute-batch`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    getActiveExecuteBatch: (projectId: string) =>
      request<PlanExecuteBatchStatus | null>(`/projects/${projectId}/plans/execute-batch/active`),
    getExecuteBatchStatus: (projectId: string, batchId: string) =>
      request<PlanExecuteBatchStatus>(`/projects/${projectId}/plans/execute-batch/${batchId}`),
    reExecute: (projectId: string, planId: string, options?: { version_number?: number }) => {
      const body: { version_number?: number } = {};
      if (options?.version_number != null) body.version_number = options.version_number;
      return request<Plan>(`/projects/${projectId}/plans/${planId}/re-execute`, {
        method: "POST",
        body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
      });
    },
    archive: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/archive`, {
        method: "POST",
      }),
    markPlanComplete: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/mark-complete`, {
        method: "POST",
      }),
    delete: (projectId: string, planId: string) =>
      request<void>(`/projects/${projectId}/plans/${planId}`, { method: "DELETE" }),
  },

  // ─── Tasks ───
  tasks: {
    list: (projectId: string) => request<TaskListResponse>(`/projects/${projectId}/tasks`),
    ready: (projectId: string) => request<Task[]>(`/projects/${projectId}/tasks/ready`),
    get: (projectId: string, taskId: string) =>
      request<Task>(`/projects/${projectId}/tasks/${taskId}`),
    updatePriority: (projectId: string, taskId: string, priority: number) =>
      request<Task>(`/projects/${projectId}/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ priority }),
      }),
    updateTask: (
      projectId: string,
      taskId: string,
      updates: { priority?: number; complexity?: number; assignee?: string | null }
    ) =>
      request<Task>(`/projects/${projectId}/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    sessions: (projectId: string, taskId: string) =>
      request<AgentSession[]>(`/projects/${projectId}/tasks/${taskId}/sessions`),
    markDone: (projectId: string, taskId: string) =>
      request<{ taskClosed: boolean; epicClosed?: boolean }>(
        `/projects/${projectId}/tasks/${taskId}/done`,
        {
          method: "POST",
        }
      ),
    delete: (projectId: string, taskId: string) =>
      request<{ taskDeleted: boolean }>(`/projects/${projectId}/tasks/${taskId}`, {
        method: "DELETE",
      }),
    unblock: (projectId: string, taskId: string, options?: { resetAttempts?: boolean }) =>
      request<{ taskUnblocked: boolean }>(`/projects/${projectId}/tasks/${taskId}/unblock`, {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }),
    addDependency: (
      projectId: string,
      taskId: string,
      parentTaskId: string,
      type?: "blocks" | "parent-child" | "related"
    ) =>
      request<void>(`/projects/${projectId}/tasks/${taskId}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ parentTaskId, type: type ?? "blocks" }),
      }),
    removeDependency: (projectId: string, taskId: string, parentTaskId: string) =>
      request<void>(`/projects/${projectId}/tasks/${taskId}/dependencies/${parentTaskId}`, {
        method: "DELETE",
      }),
    forceRetry: (projectId: string, taskId: string) =>
      request<Task>(`/projects/${projectId}/tasks/${taskId}/force-retry`, {
        method: "POST",
      }),
    openEditor: (projectId: string, taskId: string) =>
      request<OpenEditorResponse>(`/projects/${projectId}/tasks/${taskId}/open-editor`, {
        method: "POST",
      }),
    chatHistory: (projectId: string, taskId: string, attempt?: number) =>
      request<AgentChatHistoryResponse>(
        `/projects/${projectId}/tasks/${taskId}/chat-history${attempt != null ? `?attempt=${attempt}` : ""}`
      ),
    chatSupport: (projectId: string, taskId: string) =>
      request<AgentChatSupportResponse>(`/projects/${projectId}/tasks/${taskId}/chat-support`),
  },

  // ─── Execute ───
  execute: {
    status: (projectId: string) =>
      request<OrchestratorStatus>(`/projects/${projectId}/execute/status`),
    liveOutput: (projectId: string, taskId: string) =>
      request<{ output: string }>(`/projects/${projectId}/execute/tasks/${taskId}/output`),
    taskDiagnostics: (projectId: string, taskId: string) =>
      request<TaskExecutionDiagnostics>(
        `/projects/${projectId}/execute/tasks/${taskId}/diagnostics`
      ),
  },

  // ─── Deliver (phase API for deployment records) ───
  deliver: {
    expoReadiness: (projectId: string) =>
      request<ExpoReadinessResponse>(`/projects/${projectId}/deliver/expo-readiness`),
    deploy: (projectId: string, target?: string) =>
      request<{ deployId: string }>(`/projects/${projectId}/deliver`, {
        method: "POST",
        body: target != null ? JSON.stringify({ target }) : undefined,
      }),
    expoDeploy: (projectId: string, variant: "beta" | "prod") =>
      request<{ deployId: string }>(`/projects/${projectId}/deliver/expo-deploy`, {
        method: "POST",
        body: JSON.stringify({ variant }),
      }),
    status: (projectId: string) =>
      request<{ activeDeployId: string | null; currentDeploy: DeploymentRecord | null }>(
        `/projects/${projectId}/deliver/status`
      ),
    history: (projectId: string, limit?: number) =>
      request<DeploymentRecord[]>(
        `/projects/${projectId}/deliver/history${limit ? `?limit=${limit}` : ""}`
      ),
    rollback: (projectId: string, deployId: string) =>
      request<{ deployId: string }>(`/projects/${projectId}/deliver/${deployId}/rollback`, {
        method: "POST",
      }),
    updateSettings: (projectId: string, deployment: Partial<DeploymentConfig>) =>
      request<ProjectSettings>(`/projects/${projectId}/deliver/settings`, {
        method: "PUT",
        body: JSON.stringify(deployment),
      }),
    cancel: (projectId: string) =>
      request<{ cleared: boolean }>(`/projects/${projectId}/deliver/cancel`, {
        method: "POST",
      }),
  },

  // ─── Feedback ───
  feedback: {
    list: (projectId: string) => request<FeedbackItem[]>(`/projects/${projectId}/feedback`),
    submit: (
      projectId: string,
      text: string,
      images?: string[],
      parentId?: string | null,
      priority?: number | null,
      planId?: string | null,
      planVersionNumber?: number | null
    ) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback`, {
        method: "POST",
        body: JSON.stringify({
          text,
          ...(images?.length ? { images } : {}),
          ...(parentId ? { parent_id: parentId } : {}),
          ...(priority != null && priority >= 0 && priority <= 4 ? { priority } : {}),
          ...(planId ? { planId } : {}),
          ...(planVersionNumber != null && planVersionNumber >= 1 ? { planVersionNumber } : {}),
        }),
      }),
    get: (projectId: string, feedbackId: string) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback/${feedbackId}`),
    recategorize: (projectId: string, feedbackId: string, answer?: string) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback/${feedbackId}/recategorize`, {
        method: "POST",
        body: answer != null ? JSON.stringify({ answer }) : undefined,
      }),
    resolve: (projectId: string, feedbackId: string) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback/${feedbackId}/resolve`, {
        method: "POST",
      }),
    cancel: (projectId: string, feedbackId: string) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback/${feedbackId}/cancel`, {
        method: "POST",
      }),
  },

  // ─── Filesystem ───
  filesystem: {
    browse: (path?: string) =>
      request<{
        current: string;
        parent: string | null;
        entries: { name: string; path: string; isDirectory: boolean }[];
      }>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
    createFolder: (parentPath: string, name: string) =>
      request<{ path: string }>("/fs/create-folder", {
        method: "POST",
        body: JSON.stringify({ parentPath, name }),
      }),
    detectTestFramework: (path: string) =>
      request<{ framework: string; testCommand: string } | null>(
        `/fs/detect-test-framework?path=${encodeURIComponent(path)}`
      ),
  },

  // ─── Notifications (open questions / agent clarification requests) ───
  notifications: {
    listByProject: (projectId: string) =>
      request<Notification[]>(`/projects/${projectId}/notifications`),
    listGlobal: () => request<Notification[]>("/notifications"),
    clearAllByProject: (projectId: string) =>
      request<{ deletedCount: number }>(`/projects/${projectId}/notifications`, {
        method: "DELETE",
      }),
    clearAllGlobal: () => request<{ deletedCount: number }>("/notifications", { method: "DELETE" }),
    resolve: (
      projectId: string,
      notificationId: string,
      body?: { approved?: boolean; responses?: Array<{ questionId: string; answer: string }> }
    ) =>
      request<Notification>(`/projects/${projectId}/notifications/${notificationId}`, {
        method: "PATCH",
        body: body ? JSON.stringify(body) : undefined,
      }),
    retryRateLimit: (projectId: string, notificationId: string) =>
      request<{ ok: boolean; resolvedCount: number }>(
        `/projects/${projectId}/notifications/${notificationId}/retry-rate-limit`,
        { method: "POST" }
      ),
  },

  // ─── Agents ───
  agents: {
    active: (projectId: string) => request<ActiveAgent[]>(`/projects/${projectId}/agents/active`),
    kill: (projectId: string, agentId: string) =>
      request<{ killed: boolean }>(`/projects/${projectId}/agents/${agentId}/kill`, {
        method: "POST",
      }),
  },

  // ─── Help (Ask a Question — ask-only agent) ───
  help: {
    chat: (body: HelpChatRequest) =>
      request<HelpChatResponse>("/help/chat", {
        method: "POST",
        body: JSON.stringify(body),
        ...NO_REQUEST_TIMEOUT,
      }),
    history: (projectId: string | null) =>
      request<HelpChatHistory>(
        `/help/chat/history${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`
      ),
    analytics: (projectId: string | null) =>
      request<TaskAnalytics>(
        `/help/analytics${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`
      ),
    agentLog: (projectId: string | null) =>
      request<AgentLogEntry[]>(
        `/help/agent-log${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`
      ),
    sessionLog: (sessionId: number) =>
      request<{ content: string }>(`/help/session-log/${sessionId}`),
  },

  // ─── Chat ───
  chat: {
    send: (
      projectId: string,
      message: string,
      context?: string,
      prdSectionFocus?: string,
      images?: string[],
      taskContext?: ExecuteTaskContext,
      requestOptions?: { timeoutMs?: number | null }
    ) =>
      request<ChatResponse>(`/projects/${projectId}/chat`, {
        method: "POST",
        body: JSON.stringify({
          message,
          context,
          prdSectionFocus,
          ...(images?.length ? { images } : {}),
          ...(taskContext ? { taskContext } : {}),
        } satisfies Partial<ChatRequest>),
        ...(requestOptions ?? NO_REQUEST_TIMEOUT),
      }),
    history: (projectId: string, context?: string) =>
      request<Conversation>(
        `/projects/${projectId}/chat/history${context ? `?context=${encodeURIComponent(context)}` : ""}`
      ),
  },

  // ─── Integrations ───
  integrations: {
    todoist: {
      getStatus: (projectId: string) =>
        request<TodoistIntegrationStatus>(`/projects/${projectId}/integrations/todoist/status`),
      startOAuth: (projectId: string) =>
        request<TodoistOAuthStartResponse>(
          `/projects/${projectId}/integrations/todoist/oauth/start`,
          { method: "POST" }
        ),
      listProjects: (projectId: string) =>
        request<{ projects: TodoistProjectInfo[] }>(
          `/projects/${projectId}/integrations/todoist/projects`
        ),
      selectProject: (projectId: string, body: TodoistProjectSelectionRequest) =>
        request<{ success: boolean; selectedProject: { id: string; name: string } }>(
          `/projects/${projectId}/integrations/todoist/project`,
          { method: "PUT", body: JSON.stringify(body) }
        ),
      syncNow: (projectId: string) =>
        request<TodoistSyncResult>(`/projects/${projectId}/integrations/todoist/sync`, {
          method: "POST",
        }),
      disconnect: (projectId: string) =>
        request<{ disconnected: boolean; pendingDeletesWarning?: number }>(
          `/projects/${projectId}/integrations/todoist`,
          { method: "DELETE" }
        ),
    },
    github: {
      getStatus: (projectId: string) =>
        request<IntegrationStatusResponse>(`/projects/${projectId}/integrations/github/status`),
      connect: (projectId: string, body: GitHubConnectRequest) =>
        request<{ success: boolean; user: string }>(
          `/projects/${projectId}/integrations/github/connect`,
          { method: "POST", body: JSON.stringify(body) }
        ),
      listRepos: (projectId: string) =>
        request<{ repos: IntegrationSourceOption[] }>(
          `/projects/${projectId}/integrations/github/repos`
        ),
      selectRepo: (projectId: string, body: GitHubRepoSelectionRequest) =>
        request<{ success: boolean; selectedSource: { id: string; name: string } }>(
          `/projects/${projectId}/integrations/github/repo`,
          { method: "PUT", body: JSON.stringify(body) }
        ),
      syncNow: (projectId: string) =>
        request<IntegrationSyncResponse>(`/projects/${projectId}/integrations/github/sync`, {
          method: "POST",
        }),
      disconnect: (projectId: string) =>
        request<{ disconnected: boolean }>(`/projects/${projectId}/integrations/github`, {
          method: "DELETE",
        }),
    },
  },

  // ─── Intake ───
  intake: {
    list: (projectId: string, params?: Record<string, string>) => {
      const qs = params ? "?" + new URLSearchParams(params).toString() : "";
      return request<{ items: IntakeItem[]; total: number }>(`/projects/${projectId}/intake${qs}`);
    },
    get: (projectId: string, itemId: string) =>
      request<IntakeItem>(`/projects/${projectId}/intake/${itemId}`),
    convert: (projectId: string, itemId: string, body: { action: string; linkTaskId?: string }) =>
      request<{ intakeItemId: string; action: string }>(
        `/projects/${projectId}/intake/${itemId}/convert`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      ),
    ignore: (projectId: string, itemId: string) =>
      request<IntakeItem>(`/projects/${projectId}/intake/${itemId}/ignore`, { method: "POST" }),
    bulk: (projectId: string, body: { itemIds: string[]; action: string; dryRun?: boolean }) =>
      request<{ processed: number; errors: number; results: unknown[] }>(
        `/projects/${projectId}/intake/bulk`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      ),
  },

  // ─── Commands ───
  commands: {
    interpret: (projectId: string, input: string) =>
      request<{ interpretation: CommandInterpretation; commandRunId: string }>(
        `/projects/${projectId}/commands/interpret`,
        { method: "POST", body: JSON.stringify({ input }) }
      ),
    preview: (projectId: string, intent: CommandIntent) =>
      request<{ preview: CommandPreview; commandRunId: string }>(
        `/projects/${projectId}/commands/preview`,
        { method: "POST", body: JSON.stringify({ intent }) }
      ),
    apply: (projectId: string, commandRunId: string, idempotencyKey?: string) =>
      request<{ result: CommandExecutionResult; commandRunId: string }>(
        `/projects/${projectId}/commands/apply`,
        { method: "POST", body: JSON.stringify({ commandRunId, idempotencyKey }) }
      ),
  },
};
