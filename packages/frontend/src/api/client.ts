import type {
  Project,
  CreateProjectRequest,
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
  CrossEpicDependenciesResponse,
  Task,
  AgentSession,
  OrchestratorStatus,
  FeedbackItem,
  ChatRequest,
  ChatResponse,
  Conversation,
  ActiveAgent,
  DeploymentRecord,
  DeploymentConfig,
} from "@opensprint/shared";

const BASE_URL = "/api/v1";

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
    const error = await response.json().catch(() => ({
      error: { code: "UNKNOWN", message: response.statusText },
    }));
    throw new Error(error.error?.message ?? "Request failed");
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
    list: (provider: string) => request<ModelOption[]>(`/models?provider=${encodeURIComponent(provider)}`),
  },
  env: {
    getKeys: () => request<{ anthropic: boolean; cursor: boolean }>("/env/keys"),
    saveKey: (key: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY", value: string) =>
      request<{ saved: boolean }>("/env/keys", {
        method: "POST",
        body: JSON.stringify({ key, value }),
      }),
  },
  projects: {
    list: () => request<Project[]>("/projects"),
    get: (id: string) => request<Project>(`/projects/${id}`),
    getPlanStatus: (id: string) => request<PlanStatusResponse>(`/projects/${id}/plan-status`),
    create: (data: CreateProjectRequest) =>
      request<Project>("/projects", {
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
    delete: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),
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
    getHistory: (projectId: string) => request<PrdChangeLogEntry[]>(`/projects/${projectId}/prd/history`),
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
    get: (projectId: string, planId: string) => request<Plan>(`/projects/${projectId}/plans/${planId}`),
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
      request<CrossEpicDependenciesResponse>(`/projects/${projectId}/plans/${planId}/cross-epic-dependencies`),
    execute: (projectId: string, planId: string, prerequisitePlanIds?: string[]) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/execute`, {
        method: "POST",
        body: JSON.stringify(
          prerequisitePlanIds?.length ? { prerequisitePlanIds } : {},
        ),
      }),
    reExecute: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/re-execute`, {
        method: "POST",
      }),
    archive: (projectId: string, planId: string) =>
      request<Plan>(`/projects/${projectId}/plans/${planId}/archive`, {
        method: "POST",
      }),
    dependencies: (projectId: string) => request<PlanDependencyGraph>(`/projects/${projectId}/plans/dependencies`),
  },

  // ─── Tasks ───
  tasks: {
    list: (projectId: string) => request<Task[]>(`/projects/${projectId}/tasks`),
    ready: (projectId: string) => request<Task[]>(`/projects/${projectId}/tasks/ready`),
    get: (projectId: string, taskId: string) => request<Task>(`/projects/${projectId}/tasks/${taskId}`),
    sessions: (projectId: string, taskId: string) =>
      request<AgentSession[]>(`/projects/${projectId}/tasks/${taskId}/sessions`),
    session: (projectId: string, taskId: string, attempt: number) =>
      request<AgentSession>(`/projects/${projectId}/tasks/${taskId}/sessions/${attempt}`),
    markDone: (projectId: string, taskId: string) =>
      request<{ taskClosed: boolean; epicClosed?: boolean }>(`/projects/${projectId}/tasks/${taskId}/done`, {
        method: "POST",
      }),
    unblock: (projectId: string, taskId: string, options?: { resetAttempts?: boolean }) =>
      request<{ taskUnblocked: boolean }>(`/projects/${projectId}/tasks/${taskId}/unblock`, {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }),
  },

  // ─── Execute ───
  execute: {
    status: (projectId: string) => request<OrchestratorStatus>(`/projects/${projectId}/execute/status`),
  },

  // ─── Deploy ───
  deploy: {
    deploy: (projectId: string) =>
      request<{ deployId: string }>(`/projects/${projectId}/deploy`, {
        method: "POST",
      }),
    status: (projectId: string) =>
      request<{ activeDeployId: string | null; currentDeploy: DeploymentRecord | null }>(
        `/projects/${projectId}/deploy/status`,
      ),
    history: (projectId: string, limit?: number) =>
      request<DeploymentRecord[]>(
        `/projects/${projectId}/deploy/history${limit ? `?limit=${limit}` : ""}`,
      ),
    rollback: (projectId: string, deployId: string) =>
      request<{ deployId: string }>(`/projects/${projectId}/deploy/${deployId}/rollback`, {
        method: "POST",
      }),
    updateSettings: (projectId: string, deployment: Partial<DeploymentConfig>) =>
      request<ProjectSettings>(`/projects/${projectId}/deploy/settings`, {
        method: "PUT",
        body: JSON.stringify(deployment),
      }),
  },

  // ─── Feedback ───
  feedback: {
    list: (projectId: string) => request<FeedbackItem[]>(`/projects/${projectId}/feedback`),
    submit: (projectId: string, text: string, images?: string[], parentId?: string | null) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback`, {
        method: "POST",
        body: JSON.stringify({
          text,
          ...(images?.length ? { images } : {}),
          ...(parentId ? { parent_id: parentId } : {}),
        }),
      }),
    get: (projectId: string, feedbackId: string) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback/${feedbackId}`),
    recategorize: (projectId: string, feedbackId: string) =>
      request<FeedbackItem>(`/projects/${projectId}/feedback/${feedbackId}/recategorize`, {
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
    detectTestFramework: (path: string) =>
      request<{ framework: string; testCommand: string } | null>(
        `/fs/detect-test-framework?path=${encodeURIComponent(path)}`,
      ),
  },

  // ─── Agents ───
  agents: {
    active: (projectId: string) => request<ActiveAgent[]>(`/projects/${projectId}/agents/active`),
  },

  // ─── Chat ───
  chat: {
    send: (projectId: string, message: string, context?: string, prdSectionFocus?: string) =>
      request<ChatResponse>(`/projects/${projectId}/chat`, {
        method: "POST",
        body: JSON.stringify({ message, context, prdSectionFocus } satisfies Partial<ChatRequest>),
      }),
    history: (projectId: string, context?: string) =>
      request<Conversation>(`/projects/${projectId}/chat/history${context ? `?context=${context}` : ""}`),
  },
};
