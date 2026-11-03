/** Central query key factory for TanStack Query. Use these in hooks and in WebSocket middleware. */

export const queryKeys = {
  governance: {
    summary: (projectId: string) => ["governance", projectId] as const,
    caseEvidence: (projectId: string, caseId: string, version: number, evidenceHash: string) =>
      ["governance", projectId, "case", caseId, version, evidenceHash] as const,
  },
  projects: {
    all: ["projects"] as const,
    detail: (projectId: string) => ["projects", projectId] as const,
    settings: (projectId: string) => ["projects", projectId, "settings"] as const,
    selfImprovementStatus: (projectId: string) =>
      ["projects", projectId, "self-improvement-status"] as const,
    selfImprovementHistory: (projectId: string) =>
      ["projects", projectId, "self-improvement-history"] as const,
  },
  prd: {
    detail: (projectId: string) => ["prd", projectId] as const,
    history: (projectId: string) => ["prd", projectId, "history"] as const,
    proposedDiff: (projectId: string, requestId: string) =>
      ["prd", projectId, "proposed-diff", requestId] as const,
    versionDiff: (projectId: string, fromVersion: string, toVersion?: string) =>
      ["prd", projectId, "version-diff", fromVersion, toVersion ?? "current"] as const,
  },
  chat: {
    history: (projectId: string, context: string) => ["chat", projectId, context] as const,
  },
  agents: {
    active: (projectId: string) => ["agents", "active", projectId] as const,
    global: () => ["agents", "global"] as const,
  },
  plans: {
    list: (projectId: string) => ["plans", projectId] as const,
    /** Mutation key for POST …/plans/decompose (tracked globally for Plan tab loading UI). */
    decompose: (projectId: string) => ["plans", projectId, "decompose"] as const,
    status: (projectId: string) => ["plans", projectId, "status"] as const,
    detail: (projectId: string, planId: string) => ["plans", projectId, planId] as const,
    hierarchy: (projectId: string, planId: string) =>
      ["plans", projectId, planId, "hierarchy"] as const,
    versions: (projectId: string, planId: string) =>
      ["plans", projectId, planId, "versions"] as const,
    version: (projectId: string, planId: string, versionNumber: number) =>
      ["plans", projectId, planId, "versions", versionNumber] as const,
    auditorRuns: (projectId: string, planId: string) =>
      ["plans", projectId, planId, "auditor-runs"] as const,
    chat: (projectId: string, context: string) => ["plans", projectId, "chat", context] as const,
  },
  tasks: {
    list: (projectId: string) => ["tasks", projectId] as const,
    detail: (projectId: string, taskId: string) => ["tasks", projectId, taskId] as const,
    sessions: (projectId: string, taskId: string) =>
      ["tasks", projectId, taskId, "sessions"] as const,
    chatHistory: (projectId: string, taskId: string, attempt?: number) =>
      ["tasks", projectId, taskId, "chat-history", attempt ?? "latest"] as const,
    chatSupport: (projectId: string, taskId: string) =>
      ["tasks", projectId, taskId, "chat-support"] as const,
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
  notifications: {
    project: (projectId: string) => ["notifications", "project", projectId] as const,
    global: () => ["notifications", "global"] as const,
  },
  deliver: {
    status: (projectId: string) => ["deliver", projectId, "status"] as const,
    history: (projectId: string) => ["deliver", projectId, "history"] as const,
    expoReadiness: (projectId: string) => ["deliver", projectId, "expoReadiness"] as const,
  },
  integrations: {
    status: (projectId: string, provider: string) =>
      ["integrations", projectId, provider, "status"] as const,
    all: (projectId: string) => ["integrations", projectId] as const,
    todoistStatus: (projectId: string) => ["integrations", projectId, "todoist", "status"] as const,
    todoistProjects: (projectId: string) =>
      ["integrations", projectId, "todoist", "projects"] as const,
    githubStatus: (projectId: string) => ["integrations", projectId, "github", "status"] as const,
    githubRepos: (projectId: string) => ["integrations", projectId, "github", "repos"] as const,
  },
} as const;
