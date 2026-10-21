import { Children, isValidElement, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";

/** One-time conversion of historical test fixtures to the canonical server cache. Never subscribes to Redux. */
export function seedProjectQueryFixture(
  client: QueryClient,
  projectId: string,
  fixture: unknown
): void {
  const state = fixture as {
    execute?: Record<string, unknown> & {
      taskIdsOrder?: string[];
      tasksById?: Record<string, unknown>;
      activeAgents?: unknown[];
      taskIdToStartedAt?: Record<string, string>;
    };
    plan?: {
      plans?: unknown[];
      dependencyGraph?: unknown;
      planStatus?: unknown;
      chatMessages?: Record<string, unknown[]>;
    };
    eval?: { feedback?: unknown[] };
    sketch?: { prdContent?: Record<string, string>; prdHistory?: unknown[]; messages?: unknown[] };
    openQuestions?: { byProject?: Record<string, unknown[]> };
    deliver?: { history?: unknown[]; currentDeploy?: unknown; activeDeployId?: string | null };
  };
  const seed = (queryKey: readonly unknown[], data: unknown) => {
    if (data === undefined || client.getQueryData(queryKey) !== undefined) return;
    client.setQueryDefaults(queryKey, { staleTime: Infinity });
    client.setQueryData(queryKey, data);
  };
  const tasks = (state.execute?.taskIdsOrder ?? [])
    .map((id: string) => state.execute?.tasksById?.[id])
    .filter(Boolean);
  if (tasks.length) seed(queryKeys.tasks.list(projectId), tasks);
  if (state.plan?.plans?.length)
    seed(
      queryKeys.plans.list(projectId),
      state.plan.dependencyGraph ?? { plans: state.plan.plans, edges: [] }
    );
  if (state.plan?.planStatus) seed(queryKeys.plans.status(projectId), state.plan.planStatus);
  if (state.execute) {
    seed(queryKeys.execute.status(projectId), { ...state.execute });
    seed(queryKeys.agents.active(projectId), {
      agents: state.execute.activeAgents ?? [],
      taskIdToStartedAt: state.execute.taskIdToStartedAt ?? {},
    });
  }
  if (state.eval?.feedback?.length) seed(queryKeys.feedback.list(projectId), state.eval.feedback);
  if (Object.keys(state.sketch?.prdContent ?? {}).length)
    seed(queryKeys.prd.detail(projectId), state.sketch.prdContent);
  if (state.sketch?.prdHistory?.length)
    seed(queryKeys.prd.history(projectId), state.sketch.prdHistory);
  if (state.sketch?.messages?.length)
    seed(queryKeys.chat.history(projectId, "sketch"), state.sketch.messages);
  for (const [context, messages] of Object.entries(state.plan?.chatMessages ?? {}))
    seed(queryKeys.plans.chat(projectId, context), { context, messages });
  if (state.openQuestions?.byProject?.[projectId]?.length)
    seed(queryKeys.notifications.project(projectId), state.openQuestions.byProject[projectId]);
  if (state.deliver?.history?.length)
    seed(queryKeys.deliver.history(projectId), state.deliver.history);
  if (state.deliver?.currentDeploy || state.deliver?.activeDeployId)
    seed(queryKeys.deliver.status(projectId), {
      currentDeploy: state.deliver.currentDeploy ?? null,
      activeDeployId: state.deliver.activeDeployId ?? null,
    });
}

/** Locate explicit fixture providers used by older component suites, then seed once before rendering. */
export function seedServerFixtureFromElement(
  client: QueryClient,
  tree: ReactNode,
  fallbackProjectId = "proj-1"
): void {
  let fixture: unknown;
  let projectId = fallbackProjectId;
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props as {
        store?: { getState(): unknown };
        projectId?: string;
        children?: ReactNode;
      };
      if (props.store) fixture = props.store.getState();
      if (props.projectId) projectId = props.projectId;
      visit(props.children);
    });
  visit(tree);
  if (fixture) seedProjectQueryFixture(client, projectId, fixture);
}
