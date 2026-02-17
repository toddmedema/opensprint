import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Plan, PlanStatus } from "@opensprint/shared";
import { sortPlansByStatus } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  fetchPlans,
  shipPlan,
  reshipPlan,
  archivePlan,
  fetchPlanChat,
  sendPlanMessage,
  fetchSinglePlan,
  updatePlan,
  setSelectedPlanId,
  addPlanLocally,
  setPlanError,
} from "../../store/slices/planSlice";
import { AddPlanModal } from "../../components/AddPlanModal";
import { CloseButton } from "../../components/CloseButton";
import { DependencyGraph } from "../../components/DependencyGraph";
import { PlanDetailContent } from "../../components/plan/PlanDetailContent";
import { EpicCard } from "../../components/EpicCard";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";
import { fetchTasks } from "../../store/slices/buildSlice";

export const DEPENDENCY_GRAPH_EXPANDED_KEY = "opensprint-plan-dependencyGraphExpanded";

function loadDependencyGraphExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = localStorage.getItem(DEPENDENCY_GRAPH_EXPANDED_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // ignore
  }
  return true;
}

function saveDependencyGraphExpanded(expanded: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DEPENDENCY_GRAPH_EXPANDED_KEY, String(expanded));
  } catch {
    // ignore
  }
}

interface PlanPhaseProps {
  projectId: string;
  onNavigateToBuildTask?: (taskId: string) => void;
}

export function PlanPhase({ projectId, onNavigateToBuildTask }: PlanPhaseProps) {
  const dispatch = useAppDispatch();

  /* ── Redux state ── */
  const plans = useAppSelector((s) => s.plan.plans);
  const dependencyGraph = useAppSelector((s) => s.plan.dependencyGraph);
  const selectedPlanId = useAppSelector((s) => s.plan.selectedPlanId);
  const chatMessages = useAppSelector((s) => s.plan.chatMessages);
  const loading = useAppSelector((s) => s.plan.loading);
  const shippingPlanId = useAppSelector((s) => s.plan.shippingPlanId);
  const reshippingPlanId = useAppSelector((s) => s.plan.reshippingPlanId);
  const archivingPlanId = useAppSelector((s) => s.plan.archivingPlanId);
  const error = useAppSelector((s) => s.plan.error);
  const buildTasks = useAppSelector((s) => s.build.tasks);

  /* ── Local UI state (preserved by mount-all) ── */
  const [showAddPlanModal, setShowAddPlanModal] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | PlanStatus>("all");
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [tasksSectionExpanded, setTasksSectionExpanded] = useState(true);
  const [dependencyGraphExpanded, setDependencyGraphExpanded] = useState(loadDependencyGraphExpanded);
  const [savingPlanContentId, setSavingPlanContentId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const selectedPlan = plans.find((p) => p.metadata.planId === selectedPlanId) ?? null;

  const filteredAndSortedPlans = useMemo(() => {
    const filtered =
      statusFilter === "all"
        ? plans
        : plans.filter((p) => p.status === statusFilter);
    return sortPlansByStatus(filtered);
  }, [plans, statusFilter]);

  const filteredDependencyGraph = useMemo(() => {
    if (!dependencyGraph) return null;
    const filteredPlans =
      statusFilter === "all"
        ? dependencyGraph.plans
        : dependencyGraph.plans.filter((p) => p.status === statusFilter);
    const filteredPlanIds = new Set(filteredPlans.map((p) => p.metadata.planId));
    const filteredEdges = dependencyGraph.edges.filter(
      (e) => filteredPlanIds.has(e.from) && filteredPlanIds.has(e.to),
    );
    return {
      plans: sortPlansByStatus(filteredPlans),
      edges: filteredEdges,
    };
  }, [dependencyGraph, statusFilter]);

  const planTasks = useMemo(() => {
    if (!selectedPlan?.metadata.beadEpicId) return [];
    const epicId = selectedPlan.metadata.beadEpicId;
    const gateTaskId = selectedPlan.metadata.gateTaskId;
    return buildTasks.filter(
      (t) => t.epicId === epicId && t.id !== gateTaskId
    );
  }, [selectedPlan?.metadata.beadEpicId, selectedPlan?.metadata.gateTaskId, buildTasks]);

  const planIdToTasks = useMemo(() => {
    const map = new Map<string, typeof buildTasks>();
    for (const plan of plans) {
      const epicId = plan.metadata.beadEpicId;
      const gateTaskId = plan.metadata.gateTaskId;
      if (!epicId) continue;
      const tasks = buildTasks.filter(
        (t) => t.epicId === epicId && t.id !== gateTaskId
      );
      map.set(plan.metadata.planId, tasks);
    }
    return map;
  }, [plans, buildTasks]);
  const planContext = selectedPlan ? `plan:${selectedPlan.metadata.planId}` : null;
  const currentChatMessages = planContext ? (chatMessages[planContext] ?? []) : [];

  // Fetch chat history when a plan is selected
  useEffect(() => {
    if (planContext) {
      dispatch(fetchPlanChat({ projectId, context: planContext }));
      setChatError(null);
    }
  }, [planContext, projectId, dispatch]);

  // Auto-scroll chat messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [currentChatMessages]);

  const handleShip = async (planId: string) => {
    dispatch(setPlanError(null));
    const result = await dispatch(shipPlan({ projectId, planId }));
    if (shipPlan.fulfilled.match(result)) {
      dispatch(fetchPlans(projectId));
    }
  };

  const handleReship = async (planId: string) => {
    dispatch(setPlanError(null));
    const result = await dispatch(reshipPlan({ projectId, planId }));
    if (reshipPlan.fulfilled.match(result)) {
      dispatch(fetchPlans(projectId));
    }
  };

  const handleArchive = async (planId: string) => {
    dispatch(setPlanError(null));
    const result = await dispatch(archivePlan({ projectId, planId }));
    if (archivePlan.fulfilled.match(result)) {
      dispatch(fetchPlans(projectId));
      dispatch(fetchTasks(projectId));
      dispatch(fetchSinglePlan({ projectId, planId }));
    }
  };

  const handlePlanCreated = (plan: Plan) => {
    dispatch(addPlanLocally(plan));
  };

  const handleSelectPlan = useCallback(
    (plan: Plan) => {
      dispatch(setSelectedPlanId(plan.metadata.planId));
    },
    [dispatch],
  );

  const handleClosePlan = useCallback(() => {
    dispatch(setSelectedPlanId(null));
  }, [dispatch]);

  const handlePlanContentSave = useCallback(
    async (content: string) => {
      if (!selectedPlanId) return;
      setSavingPlanContentId(selectedPlanId);
      const result = await dispatch(updatePlan({ projectId, planId: selectedPlanId, content }));
      setSavingPlanContentId(null);
      if (updatePlan.fulfilled.match(result)) {
        dispatch(fetchPlans(projectId));
      }
    },
    [dispatch, projectId, selectedPlanId],
  );

  const handleSendChat = async () => {
    if (!chatInput.trim() || !planContext || chatSending) return;

    const text = chatInput.trim();
    setChatInput("");
    setChatSending(true);
    setChatError(null);

    const result = await dispatch(
      sendPlanMessage({ projectId, message: text, context: planContext }),
    );

    if (sendPlanMessage.fulfilled.match(result)) {
      dispatch(fetchPlans(projectId));
      dispatch(fetchSinglePlan({ projectId, planId: selectedPlan!.metadata.planId }));
    } else if (sendPlanMessage.rejected.match(result)) {
      setChatError(result.error.message ?? "Failed to send message. Please try again.");
    }

    setChatSending(false);
  };

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      {error && (
        <div className="mx-4 mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center shrink-0">
          <span>{error}</span>
          <button type="button" onClick={() => dispatch(setPlanError(null))} className="text-red-500 hover:text-red-700 underline">
            Dismiss
          </button>
        </div>
      )}
      {/* Main content */}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6">
        {/* Dependency Graph — collapsible top-level container */}
        <div className="card mb-6 overflow-hidden">
          <button
            type="button"
            onClick={() => {
              const next = !dependencyGraphExpanded;
              setDependencyGraphExpanded(next);
              saveDependencyGraphExpanded(next);
            }}
            className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-100/50 transition-colors"
            aria-expanded={dependencyGraphExpanded}
            aria-controls="dependency-graph-content"
            id="dependency-graph-header"
          >
            <h3 className="text-sm font-semibold text-gray-900">Dependency Graph</h3>
            <span className="text-gray-400 text-xs" aria-hidden>
              {dependencyGraphExpanded ? "▼" : "▶"}
            </span>
          </button>
          {dependencyGraphExpanded && (
            <div id="dependency-graph-content" role="region" aria-labelledby="dependency-graph-header" className="p-4 pt-0">
              <DependencyGraph graph={filteredDependencyGraph} onPlanClick={handleSelectPlan} />
            </div>
          )}
        </div>

        {/* Plan Cards */}
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Feature Plans</h2>
            {plans.length > 0 && (
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as "all" | PlanStatus)}
                className="input text-sm py-1.5 px-2.5 w-auto min-w-[7rem]"
                aria-label="Filter plans by status"
              >
                <option value="all">All</option>
                <option value="planning">Planning</option>
                <option value="building">Building</option>
                <option value="done">Done</option>
              </select>
            )}
          </div>
          <button type="button" onClick={() => setShowAddPlanModal(true)} className="btn-primary text-sm">
            Add Feature
          </button>
        </div>

        {loading ? (
          <div className="text-center py-10 text-gray-400">Loading plans...</div>
        ) : plans.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-gray-500 mb-4">
              No plans yet. Use &ldquo;Plan it&rdquo; from the Dream phase to decompose the PRD into feature plans and
              tasks, or add a plan manually.
            </p>
            <button type="button" onClick={() => setShowAddPlanModal(true)} className="btn-primary">
              Add Feature
            </button>
          </div>
        ) : filteredAndSortedPlans.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-gray-500">
              No plans match the &ldquo;{statusFilter === "all" ? "All" : statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}&rdquo; filter.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredAndSortedPlans.map((plan) => (
              <EpicCard
                key={plan.metadata.planId}
                plan={plan}
                tasks={planIdToTasks.get(plan.metadata.planId) ?? []}
                shippingPlanId={shippingPlanId}
                reshippingPlanId={reshippingPlanId}
                onSelect={() => handleSelectPlan(plan)}
                onShip={() => handleShip(plan.metadata.planId)}
                onReship={() => handleReship(plan.metadata.planId)}
              />
            ))}
          </div>
        )}
      </div>

      {showAddPlanModal && (
        <AddPlanModal projectId={projectId} onClose={() => setShowAddPlanModal(false)} onCreated={handlePlanCreated} />
      )}

      {/* Sidebar: Plan Detail + Chat */}
      {selectedPlan && (
        <ResizableSidebar storageKey="plan" defaultWidth={420}>
          <div className="flex items-center justify-between p-4 border-b border-gray-200 shrink-0">
            <h3 className="font-semibold text-gray-900 truncate flex-1 mr-2" title={selectedPlan.metadata.planId}>
              {selectedPlan.content?.trim()
                ? (selectedPlan.content.split("\n")[0]?.replace(/^#+\s*/, "").trim() ||
                    selectedPlan.metadata.planId.replace(/-/g, " "))
                : selectedPlan.metadata.planId.replace(/-/g, " ")}
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleArchive(selectedPlan.metadata.planId)}
                disabled={!!archivingPlanId}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Archive plan (mark all ready/open tasks as done)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21 8v13H3V8" />
                  <path d="M1 3h22v5H1z" />
                  <path d="M10 12h4" />
                </svg>
              </button>
              <CloseButton onClick={handleClosePlan} ariaLabel="Close plan panel" />
            </div>
          </div>

          {/* Scrollable content area: plan + mockups + chat messages */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* Plan markdown — inline editable */}
            <PlanDetailContent
              plan={selectedPlan}
              onContentSave={handlePlanContentSave}
              saving={savingPlanContentId === selectedPlan.metadata.planId}
            />

            {/* Mockups */}
            {selectedPlan.metadata.mockups && selectedPlan.metadata.mockups.length > 0 && (
              <div className="p-4 border-b border-gray-200">
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Mockups</h4>
                <div className="space-y-3">
                  {selectedPlan.metadata.mockups.map((mockup, i) => (
                    <div key={i} className="bg-white rounded-lg border overflow-hidden">
                      <div className="px-3 py-1.5 bg-gray-50 border-b">
                        <span className="text-xs font-medium text-gray-700">{mockup.title}</span>
                      </div>
                      <pre className="p-3 text-xs leading-tight text-gray-800 overflow-x-auto font-mono whitespace-pre">
                        {mockup.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tasks — collapsible */}
            <div className="border-b border-gray-200">
              <button
                type="button"
                onClick={() => setTasksSectionExpanded(!tasksSectionExpanded)}
                className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-100/50 transition-colors"
              >
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  Tasks ({planTasks.length})
                </h4>
                <span className="text-gray-400 text-xs">
                  {tasksSectionExpanded ? "▼" : "▶"}
                </span>
              </button>
              {tasksSectionExpanded && (
                <div className="px-4 pb-4 space-y-2">
                  {planTasks.length === 0 ? (
                    <p className="text-sm text-gray-500">No tasks yet. Click &ldquo;Build It!&rdquo; to auto-generate tasks from this plan, or use the AI chat to refine the plan first.</p>
                  ) : (
                    planTasks.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => onNavigateToBuildTask?.(task.id)}
                        className="w-full flex items-center gap-2 p-2 bg-white rounded-lg border border-gray-200 text-sm text-left hover:border-brand-500 hover:bg-brand-50/50 transition-colors cursor-pointer"
                      >
                        <span
                          className={`shrink-0 w-2 h-2 rounded-full ${
                            task.kanbanColumn === "done"
                              ? "bg-green-500"
                              : task.kanbanColumn === "in_progress" || task.kanbanColumn === "in_review"
                                ? "bg-blue-500"
                                : "bg-gray-300"
                          }`}
                          title={task.kanbanColumn}
                        />
                        <span className="flex-1 truncate text-gray-900" title={task.title}>
                          {task.title}
                        </span>
                        <span className="shrink-0 text-xs text-gray-500 capitalize">
                          {task.kanbanColumn.replace(/_/g, " ")}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Chat messages */}
            <div className="p-4">
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Refine with AI</h4>
              <div className="space-y-3">
                {currentChatMessages.length === 0 && (
                  <p className="text-sm text-gray-500">
                    Chat with the planning agent to refine this plan. Ask questions, suggest changes, or request
                    updates.
                  </p>
                )}
                {currentChatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                        msg.role === "user"
                          ? "bg-brand-600 text-white"
                          : "bg-white border border-gray-200 text-gray-900"
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                ))}
                {chatSending && (
                  <div className="flex justify-start">
                    <div className="bg-white border border-gray-200 rounded-2xl px-3 py-2 text-sm text-gray-400">
                      Thinking...
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>
          </div>

          {/* Pinned chat input at bottom */}
          <div className="shrink-0 border-t border-gray-200 p-4 bg-gray-50">
            {chatError && (
              <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex justify-between items-center">
                <span>{chatError}</span>
                <button
                  type="button"
                  onClick={() => setChatError(null)}
                  className="text-red-500 hover:text-red-700 underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="flex gap-2">
              <input
                type="text"
                className="input flex-1 text-sm"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSendChat()}
                placeholder="Refine this plan..."
                disabled={chatSending}
              />
              <button
                onClick={handleSendChat}
                disabled={chatSending || !chatInput.trim()}
                className="btn-primary text-sm py-2 px-3 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </ResizableSidebar>
      )}
    </div>
  );
}
