/** Central query key factory for TanStack Query. Use these in hooks and in WebSocket middleware. */

export const queryKeys = {
  projects: {
    all: ["projects"] as const,
    detail: (projectId: string) => ["projects", projectId] as const,
  },
  prd: {
    detail: (projectId: string) => ["prd", projectId] as const,
    history: (projectId: string) => ["prd", projectId, "history"] as const,
  },
  chat: {
    history: (projectId: string, context: string) => ["chat", projectId, context] as const,
  },
  plans: {
    list: (projectId: string) => ["plans", projectId] as const,
    status: (projectId: string) => ["plans", projectId, "status"] as const,
    detail: (projectId: string, planId: string) => ["plans", projectId, planId] as const,
    chat: (projectId: string, context: string) => ["plans", projectId, "chat", context] as const,
  },
  tasks: {
    list: (projectId: string) => ["tasks", projectId] as const,
    detail: (projectId: string, taskId: string) => ["tasks", projectId, taskId] as const,
    sessions: (projectId: string, taskId: string) =>
      ["tasks", projectId, taskId, "sessions"] as const,
  },
  execute: {
    status: (projectId: string) => ["execute", projectId, "status"] as const,
    liveOutput: (projectId: string, taskId: string) =>
      ["execute", projectId, taskId, "liveOutput"] as const,
    diagnostics: (projectId: string, taskId: string) =>
      ["execute", projectId, taskId, "diagnostics"] as const,
  },
  feedback: {
    list: (projectId: string) => ["feedback", projectId] as const,
  },
  deliver: {
    status: (projectId: string) => ["deliver", projectId, "status"] as const,
    history: (projectId: string) => ["deliver", projectId, "history"] as const,
  },
} as const;
