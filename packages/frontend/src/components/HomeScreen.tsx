import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Layout } from "./layout/Layout";
import { api } from "../api/client";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { useAppDispatch } from "../store";
import { addNotification } from "../store/slices/notificationSlice";
import { CloseButton } from "./CloseButton";
import { SparklesIcon, UploadIcon } from "./icons/PrdIcons";
import { GITHUB_REPO_URL, HOMEPAGE_CONTAINER_CLASS } from "../lib/constants";
import { getDropdownPositionLeftAligned } from "../lib/dropdownViewport";
import { PREREQ_ITEMS, getPrereqInstallUrl } from "../lib/prerequisites";
import { useModalA11y } from "../hooks/useModalA11y";
import type { Project } from "@opensprint/shared";

const DROPDOWN_MIN_WIDTH = 140;

function KebabIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
      />
    </svg>
  );
}

interface EmptyStateActionCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  iconToneClassName: string;
  onClick: () => void;
  dataTestId: string;
}

function EmptyStateActionCard({
  title,
  description,
  icon,
  iconToneClassName,
  onClick,
  dataTestId,
}: EmptyStateActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[15rem] h-full flex-col overflow-hidden rounded-[1.75rem] border border-theme-border bg-theme-bg p-6 text-left shadow-sm transition-colors duration-200 hover:border-brand-600 hover:bg-theme-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 sm:p-8"
      data-testid={dataTestId}
    >
      <div className="flex items-center gap-4">
        <span
          className={`inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${iconToneClassName}`}
          aria-hidden
        >
          {icon}
        </span>
        <span className="text-2xl font-semibold tracking-tight text-theme-text">{title}</span>
      </div>
      <span className="mt-3 text-sm leading-6 text-theme-muted">{description}</span>
    </button>
  );
}

interface ProjectActionConfirmModalProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
  confirmDisabled?: boolean;
  children?: React.ReactNode;
  /** Ref to element that opened the modal; focus returns here on close */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

function ProjectActionConfirmModal({
  title,
  message,
  onConfirm,
  onCancel,
  confirming = false,
  confirmDisabled = false,
  children,
  triggerRef,
}: ProjectActionConfirmModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useModalA11y({ containerRef, onClose: onCancel, triggerRef, isOpen: true });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 w-full h-full bg-theme-overlay backdrop-blur-sm border-0 cursor-default"
        onClick={onCancel}
        aria-label="Close"
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-action-modal-title"
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border shrink-0">
          <h2 id="project-action-modal-title" className="text-lg font-semibold text-theme-text">
            {title}
          </h2>
          <CloseButton onClick={onCancel} ariaLabel="Close modal" />
        </div>
        <div className="px-5 py-4 min-h-0 overflow-y-auto">
          <p className="text-sm text-theme-text">{message}</p>
          {children}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl shrink-0">
          <button type="button" onClick={onCancel} className="btn-secondary" disabled={confirming}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming || confirmDisabled}
            className="btn-primary disabled:opacity-50"
          >
            {confirming ? "Processing…" : "Proceed"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function HomeScreen() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsLoadError, setProjectsLoadError] = useState<string | null>(null);
  const [prerequisites, setPrerequisites] = useState<{
    missing: string[];
    platform: string;
  } | null>(null);
  const [restartingBackend, setRestartingBackend] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);
  const [archiveModal, setArchiveModal] = useState<Project | null>(null);
  const [deleteModal, setDeleteModal] = useState<Project | null>(null);
  const closeArchiveModal = useCallback(() => setArchiveModal(null), []);
  const closeDeleteModal = useCallback(() => setDeleteModal(null), []);
  const [confirming, setConfirming] = useState(false);
  const [removalCapability, setRemovalCapability] = useState("");
  const [removalRequiresAuthority, setRemovalRequiresAuthority] = useState(false);
  const removalCapabilityRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (removalRequiresAuthority) removalCapabilityRef.current?.focus();
  }, [removalRequiresAuthority]);
  useEffect(() => {
    setRemovalCapability("");
    setRemovalRequiresAuthority(false);
  }, [archiveModal?.id, deleteModal?.id]);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const missingPrereqCount = prerequisites?.missing.length ?? 0;
  const hasMissingPrerequisites = missingPrereqCount > 0;
  const showProjectsEmptyState =
    !hasMissingPrerequisites && !loading && !projectsLoadError && projects.length === 0;

  const handleCreateOrAddClick = async (
    route: "/projects/create-new" | "/projects/add-existing"
  ) => {
    try {
      const { hasAnyKey, useCustomCli } = await api.env.getGlobalStatus();
      if (hasAnyKey || useCustomCli) {
        navigate(route);
      } else {
        navigate(`/onboarding?intended=${encodeURIComponent(route)}`);
      }
    } catch {
      navigate(route);
    }
  };

  const refreshProjects = () => {
    api.projects
      .list()
      .then((data) => {
        setProjects(data);
        setProjectsLoadError(null);
      })
      .catch(console.error);
  };

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setLoading(true);
    setProjectsLoadError(null);
    api.projects
      .list(ac.signal)
      .then((data) => {
        if (!cancelled) {
          setProjects(data);
          setProjectsLoadError(null);
        }
      })
      .catch((err) => {
        if (!cancelled && err?.name !== "AbortError") {
          console.error(err);
          const code =
            typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
          if (code === "LOCAL_SESSION_AUTH_REQUIRED") {
            setProjectsLoadError(
              "Open Sprint could not authenticate this window to the local backend. Restart Open Sprint to refresh the local session."
            );
          } else {
            setProjectsLoadError(
              "Open Sprint could not load your projects right now. Check the backend status and try again."
            );
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

  // Initial fetch: in Electron use fresh check (login shell) so we see newly installed tools; otherwise use API.
  useEffect(() => {
    const fetchPrereqs = (): Promise<{ missing: string[]; platform: string; path?: string }> => {
      if (typeof window !== "undefined" && window.electron?.checkPrerequisitesFresh) {
        return window.electron.checkPrerequisitesFresh();
      }
      return api.env.getPrerequisites().then((r) => ({ ...r, path: undefined }));
    };
    fetchPrereqs()
      .then((r) => setPrerequisites({ missing: r.missing, platform: r.platform }))
      .catch(() => setPrerequisites(null));
  }, []);

  // Poll when prerequisites are missing. In Electron, use fresh check; when all met, restart backend with refreshed PATH.
  useEffect(() => {
    if (missingPrereqCount === 0) return;
    const isElectron = typeof window !== "undefined" && window.electron?.checkPrerequisitesFresh;
    const intervalId = setInterval(async () => {
      try {
        if (isElectron && window.electron?.checkPrerequisitesFresh) {
          const fresh = await window.electron.checkPrerequisitesFresh();
          setPrerequisites((prev) =>
            prev ? { ...prev, missing: fresh.missing, platform: fresh.platform } : null
          );
          if (fresh.missing.length === 0) {
            clearInterval(intervalId);
            if (fresh.path && window.electron?.restartBackendWithPath) {
              setRestartingBackend(true);
              try {
                await window.electron.restartBackendWithPath(fresh.path);
                setPrerequisites((prev) => (prev ? { ...prev, missing: [] } : null));
              } finally {
                setRestartingBackend(false);
              }
            } else {
              setPrerequisites((prev) => (prev ? { ...prev, missing: [] } : null));
            }
          }
        } else {
          const r = await api.env.getPrerequisites();
          setPrerequisites((prev) =>
            prev ? { ...prev, missing: r.missing, platform: r.platform } : null
          );
        }
      } catch {
        // ignore poll errors
      }
    }, 3000);
    return () => clearInterval(intervalId);
  }, [missingPrereqCount]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      const inTrigger = menuRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inTrigger && !inDropdown) {
        setMenuOpenId(null);
        setMenuAnchorRect(null);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const trigger = menuRef.current?.querySelector("button");
        setMenuOpenId(null);
        setMenuAnchorRect(null);
        requestAnimationFrame(() => trigger?.focus());
      }
    }
    if (menuOpenId) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [menuOpenId]);

  const openProject = (project: Project) => {
    navigate(getProjectPhasePath(project.id, "sketch"));
  };

  const handleArchive = async () => {
    if (!archiveModal) return;
    setConfirming(true);
    try {
      await api.projects.archive(
        archiveModal.id,
        ...(removalCapability ? [removalCapability] : [])
      );
      setArchiveModal(null);
      setMenuOpenId(null);
      refreshProjects();
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "GOVERNANCE_HUMAN_REQUIRED")
        setRemovalRequiresAuthority(true);
      dispatch(
        addNotification({
          message: err instanceof Error ? err.message : "Failed to archive project",
          severity: "error",
        })
      );
    } finally {
      setConfirming(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteModal) return;
    setConfirming(true);
    try {
      await api.projects.delete(deleteModal.id, ...(removalCapability ? [removalCapability] : []));
      setDeleteModal(null);
      setMenuOpenId(null);
      refreshProjects();
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "GOVERNANCE_HUMAN_REQUIRED")
        setRemovalRequiresAuthority(true);
      dispatch(
        addNotification({
          message: err instanceof Error ? err.message : "Failed to delete project",
          severity: "error",
        })
      );
    } finally {
      setConfirming(false);
    }
  };

  const removalAuthorization = removalRequiresAuthority ? (
    <label className="mt-4 block text-sm font-medium text-theme-text">
      Owner approval capability
      <input
        ref={removalCapabilityRef}
        type="password"
        autoComplete="off"
        value={removalCapability}
        onChange={(event) => setRemovalCapability(event.target.value)}
        className="mt-1.5 w-full rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-theme-text"
      />
      <span className="mt-1 block text-xs font-normal text-theme-muted">
        Governed projects require owner approval. Pending dockets and publication must be resolved
        first.
      </span>
    </label>
  ) : null;
  return (
    <Layout>
      <div
        className={`${HOMEPAGE_CONTAINER_CLASS} ${
          showProjectsEmptyState ? "py-4 sm:py-6 flex flex-col justify-center" : "py-6 sm:py-10"
        } flex-1 min-h-0 overflow-y-auto`}
        data-testid="project-list-container"
      >
        {hasMissingPrerequisites && prerequisites && (
          <div
            className="mb-8 p-4 rounded-xl border border-theme-border bg-theme-surface-muted/50"
            data-testid="installation-checklist"
          >
            <h2 className="text-lg font-semibold text-theme-text mb-3">Installation checklist</h2>
            <p className="text-sm text-theme-muted mb-4">
              Install the following so you can create new projects. We check every few seconds—once
              everything is installed, we&apos;ll detect it and restart the backend so you can
              continue without restarting the app.
            </p>
            <ul className="space-y-2">
              {PREREQ_ITEMS.map((tool) => {
                const isMissing = prerequisites.missing.includes(tool);
                return (
                  <li
                    key={tool}
                    className="flex items-center justify-between gap-3 text-sm"
                    data-testid={`prereq-row-${tool.toLowerCase().replace(".", "")}`}
                  >
                    <span className="text-theme-text font-medium">{tool}</span>
                    {isMissing ? (
                      <a
                        href={getPrereqInstallUrl(tool, prerequisites.platform)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-primary text-sm py-1.5 px-3"
                        data-testid={`prereq-install-${tool.toLowerCase().replace(".", "")}`}
                      >
                        Install
                      </a>
                    ) : (
                      <span
                        className="text-theme-muted flex items-center gap-1.5"
                        aria-label={`${tool} installed`}
                      >
                        <span className="text-green-600 dark:text-green-400" aria-hidden>
                          ✓
                        </span>
                        Installed
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {restartingBackend && (
              <p className="mt-3 text-sm text-theme-muted" data-testid="restarting-backend-message">
                Restarting backend so new tools are available…
              </p>
            )}
            {typeof window !== "undefined" && window.electron?.restartApp && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={() => void window.electron?.restartApp?.()}
                  className="btn-secondary"
                  data-testid="restart-app-button"
                >
                  Restart Open Sprint
                </button>
              </div>
            )}
          </div>
        )}

        {!hasMissingPrerequisites && (
          <>
            {loading ? (
              <div className="text-center py-20 text-theme-muted">Loading projects...</div>
            ) : projectsLoadError ? (
              <section
                className="card w-full px-6 py-6 sm:px-8"
                data-testid="projects-load-error"
                aria-live="polite"
              >
                <h2 className="text-xl font-semibold text-theme-text">Could not load projects</h2>
                <p className="mt-2 text-sm text-theme-muted">{projectsLoadError}</p>
                {typeof window !== "undefined" && window.electron?.restartApp && (
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => void window.electron?.restartApp?.()}
                      className="btn-secondary"
                      data-testid="restart-app-button"
                    >
                      Restart Open Sprint
                    </button>
                  </div>
                )}
              </section>
            ) : projects.length === 0 ? (
              <section
                className="relative isolate overflow-hidden card w-full min-h-[clamp(30rem,68vh,48rem)] px-6 py-10 sm:px-10 lg:px-14"
                data-testid="projects-empty-state"
              >
                <div
                  className="pointer-events-none absolute -left-16 top-8 h-48 w-48 rounded-full bg-sky-500/15 blur-3xl"
                  aria-hidden
                />
                <div
                  className="pointer-events-none absolute right-0 top-0 h-56 w-56 rounded-full bg-brand-500/15 blur-3xl"
                  aria-hidden
                />
                <div
                  className="pointer-events-none absolute bottom-8 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-amber-400/10 blur-3xl"
                  aria-hidden
                />

                <div className="relative z-10 flex h-full flex-col items-center justify-center text-center">
                  <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-theme-text sm:text-5xl lg:text-6xl">
                    Start your first sprint
                  </h1>
                  <p className="mt-4 max-w-2xl text-base leading-7 text-theme-muted sm:text-lg">
                    Bring an existing codebase into Open Sprint or spin up a fresh repo and let the
                    agents carry it from sketch to delivery.
                  </p>

                  <div
                    className="mt-10 grid w-full max-w-4xl gap-4 md:grid-cols-2"
                    data-testid="empty-state-actions"
                  >
                    <EmptyStateActionCard
                      title="Add Existing"
                      description="Connect a repo you already have and organize tasks, plans, and feedback in one place."
                      icon={<UploadIcon className="h-7 w-7" />}
                      iconToneClassName="bg-theme-info-bg text-theme-info-text"
                      onClick={() => handleCreateOrAddClick("/projects/add-existing")}
                      dataTestId="add-existing-button"
                    />
                    <EmptyStateActionCard
                      title="Create New"
                      description="Generate a brand new project from a starter template and jump straight into the SPEED workflow."
                      icon={<SparklesIcon className="h-7 w-7" />}
                      iconToneClassName="bg-theme-success-bg text-theme-success-text"
                      onClick={() => handleCreateOrAddClick("/projects/create-new")}
                      dataTestId="create-new-button"
                    />
                  </div>
                </div>
              </section>
            ) : (
              <>
                {/* Header: stack buttons on narrow screens */}
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 sm:gap-6 mb-10">
                  <h1 className="text-2xl sm:text-3xl font-bold text-theme-text shrink-0">
                    Projects
                  </h1>
                  <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 shrink-0 w-full sm:w-auto">
                    <button
                      type="button"
                      onClick={() => handleCreateOrAddClick("/projects/add-existing")}
                      className="btn-secondary hover:bg-theme-info-bg min-h-[44px] sm:min-h-0"
                      data-testid="add-existing-button"
                    >
                      Add Existing
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCreateOrAddClick("/projects/create-new")}
                      className="btn-primary min-h-[44px] sm:min-h-0"
                      data-testid="create-new-button"
                    >
                      Create New
                    </button>
                  </div>
                </div>

                <div className="grid gap-4 w-full" data-testid="projects-grid">
                  {projects.map((project) => (
                    <div
                      key={project.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openProject(project)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openProject(project);
                        }
                      }}
                      className="card p-4 group cursor-pointer transition-colors hover:bg-theme-info-bg min-w-0"
                      data-testid={`project-card-${project.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div
                            className="text-theme-text font-medium truncate"
                            title={project.name}
                          >
                            {project.name}
                          </div>
                          <div
                            className="text-sm text-theme-muted truncate mt-0.5"
                            title={project.repoPath}
                          >
                            {project.repoPath}
                          </div>
                        </div>
                        <div
                          className="relative flex items-center flex-shrink-0"
                          ref={menuOpenId === project.id ? menuRef : undefined}
                          role="button"
                          tabIndex={-1}
                          aria-label="Project card menu wrapper"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key !== "Escape") e.stopPropagation();
                          }}
                        >
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const button = e.currentTarget;
                              if (menuOpenId === project.id) {
                                setMenuOpenId(null);
                                setMenuAnchorRect(null);
                              } else {
                                setMenuAnchorRect(button.getBoundingClientRect());
                                setMenuOpenId(project.id);
                              }
                            }}
                            className="p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
                            aria-label="Project actions"
                            aria-expanded={menuOpenId === project.id}
                            aria-haspopup="menu"
                            data-testid={`project-card-menu-${project.id}`}
                          >
                            <KebabIcon className="w-5 h-5" />
                          </button>
                          {menuOpenId === project.id &&
                            menuAnchorRect &&
                            createPortal(
                              <div
                                ref={dropdownRef}
                                className="py-1 bg-theme-surface border border-theme-border rounded-lg shadow-lg"
                                role="menu"
                                data-testid={`project-card-dropdown-${project.id}`}
                                style={getDropdownPositionLeftAligned(menuAnchorRect, {
                                  minWidth: DROPDOWN_MIN_WIDTH,
                                  estimatedHeight: 100,
                                })}
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    modalTriggerRef.current =
                                      menuRef.current?.querySelector("button") ?? null;
                                    setArchiveModal(project);
                                    setMenuOpenId(null);
                                    setMenuAnchorRect(null);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm text-theme-text hover:bg-theme-info-bg"
                                >
                                  Archive
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    modalTriggerRef.current =
                                      menuRef.current?.querySelector("button") ?? null;
                                    setDeleteModal(project);
                                    setMenuOpenId(null);
                                    setMenuAnchorRect(null);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm text-theme-text hover:bg-theme-info-bg"
                                >
                                  Delete
                                </button>
                              </div>,
                              document.body
                            )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {archiveModal && (
        <ProjectActionConfirmModal
          title="Archive project"
          message="This will remove the project from the UI, but not delete its data."
          onConfirm={handleArchive}
          onCancel={closeArchiveModal}
          confirming={confirming}
          confirmDisabled={removalRequiresAuthority && !removalCapability.trim()}
          triggerRef={modalTriggerRef}
        >
          {removalAuthorization}
        </ProjectActionConfirmModal>
      )}

      {deleteModal && (
        <ProjectActionConfirmModal
          title="Delete project"
          message="This will remove the project from the UI and permanently delete all Open Sprint data for this project: tasks, plans, settings, feedback, and all data in the project folder."
          onConfirm={handleDelete}
          onCancel={closeDeleteModal}
          confirming={confirming}
          confirmDisabled={removalRequiresAuthority && !removalCapability.trim()}
          triggerRef={modalTriggerRef}
        >
          {removalAuthorization}
        </ProjectActionConfirmModal>
      )}

      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-4 left-4 md:left-auto md:right-4 text-xs text-theme-muted/50 hover:text-theme-muted transition-colors min-h-[44px] min-w-[44px] flex items-center"
        data-testid="github-link"
      >
        GitHub
      </a>
    </Layout>
  );
}
