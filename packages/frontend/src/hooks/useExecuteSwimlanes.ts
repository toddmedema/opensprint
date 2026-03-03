import { useMemo } from "react";
import type { Task } from "@opensprint/shared";
import { sortEpicTasksByStatus } from "../lib/executeTaskSort";
import {
  filterTasksByStatusAndSearch,
  matchesSearchQuery,
  type StatusFilter,
} from "../lib/executeTaskFilter";
import { getEpicTitleFromPlan } from "../lib/planContentUtils";
import type { Plan } from "@opensprint/shared";

export interface Swimlane {
  epicId: string;
  epicTitle: string;
  planId: string | null;
  /** Tasks for this epic (filtered and sorted). BuildEpicCard subscribes to Redux; this is used for swimlane inclusion only. */
  tasks: Task[];
}

/** Whether to show Ready vs In Line section headers (when filter is all, ready, or in_line). */
export function showReadyInLineSections(statusFilter: StatusFilter): boolean {
  return statusFilter === "all" || statusFilter === "ready" || statusFilter === "in_line";
}

function isReadyTask(t: Task): boolean {
  return t.kanbanColumn === "ready";
}

function isInLineTask(t: Task): boolean {
  return t.kanbanColumn === "backlog" || t.kanbanColumn === "planning";
}

function buildSwimlanesFromFilteredTasks(
  tasks: Task[],
  plans: Plan[],
  statusFilter: StatusFilter,
  searchQuery: string
): Swimlane[] {
  const q = searchQuery.trim().toLowerCase();
  const searchFiltered = q ? tasks.filter((t) => matchesSearchQuery(t, searchQuery)) : tasks;

  const epicIdToTitle = new Map<string, string>();
  const epicIdToPlanId = new Map<string, string>();
  plans.forEach((p) => {
    epicIdToTitle.set(p.metadata.epicId, getEpicTitleFromPlan(p));
    epicIdToPlanId.set(p.metadata.epicId, p.metadata.planId);
  });

  const byEpic = new Map<string | null, Task[]>();
  for (const t of searchFiltered) {
    const key = t.epicId ?? null;
    if (!byEpic.has(key)) byEpic.set(key, []);
    byEpic.get(key)!.push(t);
  }

  const allDone = (ts: Task[]) => ts.length > 0 && ts.every((t) => t.kanbanColumn === "done");
  const hideCompletedEpics = statusFilter === "all";

  const includeLane = (laneTasks: Task[]) =>
    laneTasks.length > 0 && (!hideCompletedEpics || !allDone(laneTasks));

  const result: Swimlane[] = [];
  for (const plan of plans) {
    const epicId = plan.metadata.epicId;
    if (!epicId) continue;
    const laneTasks = byEpic.get(epicId) ?? [];
    if (includeLane(laneTasks)) {
      result.push({
        epicId,
        epicTitle: epicIdToTitle.get(epicId) ?? epicId,
        planId: epicIdToPlanId.get(epicId) ?? null,
        tasks: sortEpicTasksByStatus(laneTasks),
      });
    }
  }
  const seenEpics = new Set(result.map((r) => r.epicId));
  for (const [epicId, laneTasks] of byEpic) {
    if (epicId && !seenEpics.has(epicId) && includeLane(laneTasks)) {
      result.push({
        epicId,
        epicTitle: epicId,
        planId: epicIdToPlanId.get(epicId) ?? null,
        tasks: sortEpicTasksByStatus(laneTasks),
      });
      seenEpics.add(epicId);
    }
  }
  const unassigned = byEpic.get(null) ?? [];
  if (includeLane(unassigned)) {
    result.push({
      epicId: "",
      epicTitle: "Other",
      planId: null,
      tasks: sortEpicTasksByStatus(unassigned),
    });
  }
  return result;
}

export function useExecuteSwimlanes(
  tasks: Task[],
  plans: Plan[],
  statusFilter: StatusFilter,
  searchQuery: string
) {
  const implTasks = useMemo(() => tasks.filter((t) => t.type !== "epic"), [tasks]);

  const filteredTasks = useMemo(
    () => filterTasksByStatusAndSearch(implTasks, statusFilter, searchQuery),
    [implTasks, statusFilter, searchQuery]
  );

  const swimlanes = useMemo((): Swimlane[] => {
    const epicIdToTitle = new Map<string, string>();
    const epicIdToPlanId = new Map<string, string>();
    plans.forEach((p) => {
      epicIdToTitle.set(p.metadata.epicId, getEpicTitleFromPlan(p));
      epicIdToPlanId.set(p.metadata.epicId, p.metadata.planId);
    });

    const byEpic = new Map<string | null, Task[]>();
    for (const t of filteredTasks) {
      const key = t.epicId ?? null;
      if (!byEpic.has(key)) byEpic.set(key, []);
      byEpic.get(key)!.push(t);
    }

    const allDone = (ts: Task[]) => ts.length > 0 && ts.every((t) => t.kanbanColumn === "done");
    const hideCompletedEpics = statusFilter === "all";

    const includeLane = (laneTasks: Task[]) =>
      laneTasks.length > 0 && (!hideCompletedEpics || !allDone(laneTasks));

    const result: Swimlane[] = [];
    for (const plan of plans) {
      const epicId = plan.metadata.epicId;
      if (!epicId) continue;
      const laneTasks = byEpic.get(epicId) ?? [];
      if (includeLane(laneTasks)) {
        result.push({
          epicId,
          epicTitle: epicIdToTitle.get(epicId) ?? epicId,
          planId: epicIdToPlanId.get(epicId) ?? null,
          tasks: sortEpicTasksByStatus(laneTasks),
        });
      }
    }
    const seenEpics = new Set(result.map((r) => r.epicId));
    for (const [epicId, laneTasks] of byEpic) {
      if (epicId && !seenEpics.has(epicId) && includeLane(laneTasks)) {
        result.push({
          epicId,
          epicTitle: epicId,
          planId: epicIdToPlanId.get(epicId) ?? null,
          tasks: sortEpicTasksByStatus(laneTasks),
        });
        seenEpics.add(epicId);
      }
    }
    const unassigned = byEpic.get(null) ?? [];
    if (includeLane(unassigned)) {
      result.push({
        epicId: "",
        epicTitle: "Other",
        planId: null,
        tasks: sortEpicTasksByStatus(unassigned),
      });
    }
    return result;
  }, [filteredTasks, plans, statusFilter]);

  const totalTasks = implTasks.length;
  const inLineCount = implTasks.filter(
    (t) => t.kanbanColumn === "backlog" || t.kanbanColumn === "planning"
  ).length;
  const readyCount = implTasks.filter((t) => t.kanbanColumn === "ready").length;
  const blockedOnHumanCount = implTasks.filter((t) => t.kanbanColumn === "blocked").length;
  const inProgressCount = implTasks.filter((t) => t.kanbanColumn === "in_progress").length;
  const inReviewCount = implTasks.filter((t) => t.kanbanColumn === "in_review").length;
  const doneCount = implTasks.filter((t) => t.kanbanColumn === "done").length;

  const chipConfig: { label: string; filter: StatusFilter; count: number }[] = [
    { label: "All", filter: "all", count: totalTasks },
    { label: "In Line", filter: "in_line", count: inLineCount },
    { label: "Ready", filter: "ready", count: readyCount },
    { label: "In Progress", filter: "in_progress", count: inProgressCount + inReviewCount },
    { label: "Done", filter: "done", count: doneCount },
    ...(blockedOnHumanCount > 0
      ? [
          {
            label: "⚠️ Blocked on Human",
            filter: "blocked" as StatusFilter,
            count: blockedOnHumanCount,
          },
        ]
      : []),
  ];

  const readySwimlanes = useMemo((): Swimlane[] => {
    if (statusFilter !== "all" && statusFilter !== "ready") return [];
    const readyTasks = implTasks.filter(isReadyTask);
    return buildSwimlanesFromFilteredTasks(readyTasks, plans, statusFilter, searchQuery);
  }, [implTasks, plans, statusFilter, searchQuery]);

  const inLineSwimlanes = useMemo((): Swimlane[] => {
    if (statusFilter !== "all" && statusFilter !== "in_line") return [];
    const inLineTasks = implTasks.filter(isInLineTask);
    return buildSwimlanesFromFilteredTasks(inLineTasks, plans, statusFilter, searchQuery);
  }, [implTasks, plans, statusFilter, searchQuery]);

  return {
    implTasks,
    filteredTasks,
    swimlanes,
    readySwimlanes,
    inLineSwimlanes,
    chipConfig,
  };
}
