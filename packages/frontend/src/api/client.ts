import type {
  Project,
  CreateProjectRequest,
  ScaffoldProjectRequest,
  ScaffoldProjectResponse,
  UpdateProjectRequest,
  ProjectSettings,
  Prd,
  PrdSection,
  PrdChangeLogEntry,
  PrdSectionUpdateResult,
  PrdUploadResult,
  Plan,
  PlanDependencyGraph,
  PlanStatusResponse,
  CreatePlanRequest,
  UpdatePlanRequest,
  SuggestPlansResponse,
  GeneratePlanRequest,
  CrossEpicDependenciesResponse,
  Task,
  AgentSession,
  OrchestratorStatus,
  FeedbackItem,
  ChatRequest,
  ChatResponse,
  Conversation,
  ActiveAgent,
  Notification,
  DeploymentRecord,
  DeploymentConfig,
  HelpChatRequest,
  HelpChatResponse,
  HelpChatHistory,
} from "@opensprint/shared";

const BASE_URL = "/api/v1";

/** Error thrown by request() when response is not ok; carries backend code, message, and optional details. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
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

/** Generic fetch wrapper with typed responses */
async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const code = body?.error?.code ?? "UNKNOWN";
    const message = body?.error?.message || response.statusText || "Request failed";
    const details = body?.error?.details;
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

// ─── Projects ───

export const api = {
  models: {
    list: (provider: string, projectId?: string) => {
      const params = new URLSearchParams({ provider });
      if (projectId) params.set("projectId", projectId);
      return request<ModelOption[]>(`/models?${params.toString()}`);
    },
  },
  env: {
    getKeys: () =>
      request<{
        anthropic: boolean;
        cursor: boolean;
        claudeCli: boolean;
        useCustomCli: boolean;
      }>("/env/keys"),
    getGlobalStatus: () =>
      request<{ hasAnyKey: boolean; useCustomCli: boolean }>("/env/global-status"),
    validateKey: (provider: "claude" | "cursor", value: string) =>
      request<{ valid: boolean; error?: string }>("/env/keys/validate", {
        method: "POST",
        body: JSON.stringify({ provider, value }),
      }),
    saveKey: (key: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY", value: string) =>
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
    updateSettings: (id: string, data: Partial<ProjectSettings>) =>
      request<ProjectSettings>(`/projects/${id}/settings`, {
        method: "PUT",
        body: JSON.stringify(data),
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
  },

  // ─── PRD ───
  prd: {
    get: (projectId: string) => request<Prd>(`/projects/${projectId}/prd`),
    getSection: (projectId: string, section: string) =>
      request<PrdSection>(`/projects/${projectId}/prd/${section}`),
    updateSection: (projectId: string, section: string, content: string) =>
      request<PrdSectionUpdateResult>(`/projects/${projectId}/prd/${section}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      }),
    getHistory: (projectId: string) =>
      request<PrdChangeLogEntry[]>(`/projects/${projectId}/prd/history`),
    upload: async (projectId: string, file: File): Promise<PrdUploadResult> => {
      const formData = new FormData();
      formData.append("file", file);
      const url = `${BASE_URL}/projects/${projectId}/prd/upload`;
      const response = await fetch(url, {
        method: "POST",
        body: formData,
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
      }),
  },

  // ─── Plans ───
  plans: {
    list: (projectId: string) => request<PlanDependencyGraph>(`/projects/${projectId}/plans`),
    suggest: (projectId: string) =>
      request<SuggestPlansResponse>(`/projects/${projectId}/plans/suggest`, {
        method: "POST",
      }),
    decompose: (projectId: string) =>
      request<{ created: number; plans: Plan[] }>(`/projects/${projectId}/plans/decompose`, {
        method: "POST",
      }),
    generate: (projectId: string, data: GeneratePlanRequest) =>
      request<Plan>(`/projects/${projectId}/plans/generate`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    get: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}`),
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
    planTasks: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/plan-tasks`, {
        method: "POST",
      }),
    execute: (projectId: string, planId: string, prerequisitePlanIds?: string[]) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/execute`, {
        method: "POST",
        body: JSON.stringify(prerequisitePlanIds?.length ? { prerequisitePlanIds } : {}),
      }),
    reExecute: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/re-execute`, {
        method: "POST",
      }),
    archive: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/archive`, {
        method: "POST",
      }),
    delete: (projectId: string, planId: string) =>
      request<void>(`/projects/${projectId}/plans/${planId}`, { method: "DELETE" }),
    dependencies: (projectId: string) =>
      request<PlanDependencyGraph>(`/projects/${projectId}/plans/dependencies`),
  },

  // ─── Tasks ───
  tasks: {
    list: (projectId: string) =>
      request<Task[]>(`/projects/${projectId}/tasks`),
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
      updates: { priority?: number; complexity?: number }
    ) =>
      request<Task>(`/projects/${projectId}/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    sessions: (projectId: string, taskId: string) =>
      request<AgentSession[]>(`/projects/${projectId}/tasks/${taskId}/sessions`),
    session: (projectId: string, taskId: string, attempt: number) =>
      request<AgentSession>(`/projects/${projectId}/tasks/${taskId}/sessions/${attempt}`),
    markDone: (projectId: string, taskId: string) =>
      request<{ taskClosed: boolean; epicClosed?: boolean }>(
        `/projects/${projectId}/tasks/${taskId}/done`,
        {
          method: "POST",
        }
      ),
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
  },

  // ─── Execute ───
  execute: {
    status: (projectId: string) =>
      request<OrchestratorStatus>(`/projects/${projectId}/execute/status`),
    liveOutput: (projectId: string, taskId: string) =>
      request<{ output: string }>(`/projects/${projectId}/execute/tasks/${taskId}/output`),
  },

  // ─── Deliver (phase API for deployment records) ───
  deliver: {
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
    list: (projectId: string) =>
      request<FeedbackItem[]>(`/projects/${projectId}/feedback`),
    submit: (
      projectId: string,
      text: string,
      images?: string[],
      parentId?: string | null,
      priority?: number | null
    ) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback`, {
        method: "POST",
        body: JSON.stringify({
          text,
          ...(images?.length ? { images } : {}),
          ...(parentId ? { parent_id: parentId } : {}),
          ...(priority != null && priority >= 0 && priority <= 4 ? { priority } : {}),
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
    resolve: (
      projectId: string,
      notificationId: string,
      body?: { approved?: boolean }
    ) =>
      request<Notification>(`/projects/${projectId}/notifications/${notificationId}`, {
        method: "PATCH",
        body: body ? JSON.stringify(body) : undefined,
      }),
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
      }),
    history: (projectId: string | null) =>
      request<HelpChatHistory>(
        `/help/chat/history${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`
      ),
  },

  // ─── Chat ───
  chat: {
    send: (
      projectId: string,
      message: string,
      context?: string,
      prdSectionFocus?: string,
      images?: string[]
    ) =>
      request<ChatResponse>(`/projects/${projectId}/chat`, {
        method: "POST",
        body: JSON.stringify({
          message,
          context,
          prdSectionFocus,
          ...(images?.length ? { images } : {}),
        } satisfies Partial<ChatRequest>),
      }),
    history: (projectId: string, context?: string) =>
      request<Conversation>(
        `/projects/${projectId}/chat/history${context ? `?context=${encodeURIComponent(context)}` : ""}`
      ),
  },
};
