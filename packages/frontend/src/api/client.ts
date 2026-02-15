import type { ApiResult } from "@opensprint/shared";

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
    list: () => request<unknown[]>("/projects"),
    get: (id: string) => request<unknown>(`/projects/${id}`),
    create: (data: unknown) =>
      request<unknown>("/projects", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: unknown) =>
      request<unknown>(`/projects/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    getSettings: (id: string) => request<unknown>(`/projects/${id}/settings`),
    updateSettings: (id: string, data: unknown) =>
      request<unknown>(`/projects/${id}/settings`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),
  },

  // ─── PRD ───
  prd: {
    get: (projectId: string) => request<unknown>(`/projects/${projectId}/prd`),
    getSection: (projectId: string, section: string) => request<unknown>(`/projects/${projectId}/prd/${section}`),
    updateSection: (projectId: string, section: string, content: string) =>
      request<unknown>(`/projects/${projectId}/prd/${section}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      }),
    getHistory: (projectId: string) => request<unknown>(`/projects/${projectId}/prd/history`),
  },

  // ─── Plans ───
  plans: {
    list: (projectId: string) => request<unknown[]>(`/projects/${projectId}/plans`),
    decompose: (projectId: string) =>
      request<{ created: number; plans: unknown[] }>(`/projects/${projectId}/plans/decompose`, {
        method: "POST",
      }),
    get: (projectId: string, planId: string) => request<unknown>(`/projects/${projectId}/plans/${planId}`),
    create: (projectId: string, data: unknown) =>
      request<unknown>(`/projects/${projectId}/plans`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (projectId: string, planId: string, data: unknown) =>
      request<unknown>(`/projects/${projectId}/plans/${planId}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    ship: (projectId: string, planId: string) =>
      request<unknown>(`/projects/${projectId}/plans/${planId}/ship`, {
        method: "POST",
      }),
    reship: (projectId: string, planId: string) =>
      request<unknown>(`/projects/${projectId}/plans/${planId}/reship`, {
        method: "POST",
      }),
    dependencies: (projectId: string) => request<unknown>(`/projects/${projectId}/plans/dependencies`),
  },

  // ─── Tasks ───
  tasks: {
    list: (projectId: string) => request<unknown[]>(`/projects/${projectId}/tasks`),
    ready: (projectId: string) => request<unknown[]>(`/projects/${projectId}/tasks/ready`),
    get: (projectId: string, taskId: string) => request<unknown>(`/projects/${projectId}/tasks/${taskId}`),
    sessions: (projectId: string, taskId: string) =>
      request<unknown[]>(`/projects/${projectId}/tasks/${taskId}/sessions`),
    session: (projectId: string, taskId: string, attempt: number) =>
      request<unknown>(`/projects/${projectId}/tasks/${taskId}/sessions/${attempt}`),
  },

  // ─── Build ───
  build: {
    start: (projectId: string) =>
      request<unknown>(`/projects/${projectId}/build/start`, {
        method: "POST",
      }),
    pause: (projectId: string) =>
      request<unknown>(`/projects/${projectId}/build/pause`, {
        method: "POST",
      }),
    status: (projectId: string) => request<unknown>(`/projects/${projectId}/build/status`),
  },

  // ─── Feedback ───
  feedback: {
    list: (projectId: string) => request<unknown[]>(`/projects/${projectId}/feedback`),
    submit: (projectId: string, text: string) =>
      request<unknown>(`/projects/${projectId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    get: (projectId: string, feedbackId: string) => request<unknown>(`/projects/${projectId}/feedback/${feedbackId}`),
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
    active: (projectId: string) =>
      request<import("@opensprint/shared").ActiveAgent[]>(`/projects/${projectId}/agents/active`),
  },

  // ─── Chat ───
  chat: {
    send: (projectId: string, message: string, context?: string, prdSectionFocus?: string) =>
      request<unknown>(`/projects/${projectId}/chat`, {
        method: "POST",
        body: JSON.stringify({ message, context, prdSectionFocus }),
      }),
    history: (projectId: string, context?: string) =>
      request<unknown>(`/projects/${projectId}/chat/history${context ? `?context=${context}` : ""}`),
  },
};
