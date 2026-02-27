import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Layout } from "./layout/Layout";
import { api } from "../api/client";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { useAppDispatch } from "../store";
import { addNotification } from "../store/slices/notificationSlice";
import { CloseButton } from "./CloseButton";
import { ApiKeySetupModal } from "./ApiKeySetupModal";
import { GITHUB_REPO_URL, HOMEPAGE_CONTAINER_CLASS } from "../lib/constants";
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

interface ProjectActionConfirmModalProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
  children?: React.ReactNode;
}

function ProjectActionConfirmModal({
  title,
  message,
  onConfirm,
  onCancel,
  confirming = false,
  children,
}: ProjectActionConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onCancel} />
      <div
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 className="text-lg font-semibold text-theme-text">{title}</h2>
          <CloseButton onClick={onCancel} ariaLabel="Close modal" />
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-theme-text">{message}</p>
          {children}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
          <button type="button" onClick={onCancel} className="btn-primary" disabled={confirming}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="btn-secondary disabled:opacity-50"
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
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);
  const [archiveModal, setArchiveModal] = useState<Project | null>(null);
  const [deleteModal, setDeleteModal] = useState<Project | null>(null);
  const [apiKeyModalRoute, setApiKeyModalRoute] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleCreateOrAddClick = async (route: "/projects/create-new" | "/projects/add-existing") => {
    try {
      const { hasAnyKey, useCustomCli } = await api.env.getGlobalStatus();
      if (hasAnyKey || useCustomCli) {
        navigate(route);
      } else {
        setApiKeyModalRoute(route);
      }
    } catch {
      navigate(route);
    }
  };

  const refreshProjects = () => {
    api.projects.list().then(setProjects).catch(console.error);
  };

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setLoading(true);
    api.projects
      .list(ac.signal)
      .then((data) => {
        if (!cancelled) setProjects(data);
      })
      .catch((err) => {
        if (!cancelled && err?.name !== "AbortError") console.error(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

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
    if (menuOpenId) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [menuOpenId]);

  const openProject = (project: Project) => {
    navigate(getProjectPhasePath(project.id, "sketch"));
  };

  const handleArchive = async () => {
    if (!archiveModal) return;
    setConfirming(true);
    try {
      await api.projects.archive(archiveModal.id);
      setArchiveModal(null);
      setMenuOpenId(null);
      refreshProjects();
    } catch (err) {
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
      await api.projects.delete(deleteModal.id);
      setDeleteModal(null);
      setMenuOpenId(null);
      refreshProjects();
    } catch (err) {
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

  return (
    <Layout>
      <div className={`${HOMEPAGE_CONTAINER_CLASS} py-10`} data-testid="project-list-container">
        {/* Header */}
        <div className="flex justify-between items-center gap-6 mb-10">
          <h1 className="text-3xl font-bold text-theme-text shrink-0">Projects</h1>
          <div className="flex gap-4 shrink-0">
            <button
              type="button"
              onClick={() => handleCreateOrAddClick("/projects/add-existing")}
              className="btn-secondary hover:bg-theme-info-bg"
              data-testid="add-existing-button"
            >
              Add Existing
            </button>
            <button
              type="button"
              onClick={() => handleCreateOrAddClick("/projects/create-new")}
              className="btn-primary"
              data-testid="create-new-button"
            >
              Create New
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-20 text-theme-muted">Loading projects...</div>
        ) : (
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
                    onClick={(e) => e.stopPropagation()}
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
                      className="p-1.5 rounded text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
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
                          className="fixed py-1 bg-theme-surface border border-theme-border rounded-lg shadow-lg z-[100] min-w-[140px]"
                          role="menu"
                          data-testid={`project-card-dropdown-${project.id}`}
                          style={{
                            top: menuAnchorRect.bottom + 4,
                            left: Math.max(
                              8,
                              Math.min(
                                menuAnchorRect.right - DROPDOWN_MIN_WIDTH,
                                window.innerWidth - DROPDOWN_MIN_WIDTH - 8
                              )
                            ),
                          }}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
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
        )}
      </div>

      {archiveModal && (
        <ProjectActionConfirmModal
          title="Archive project"
          message="This will remove the project from the UI, but not delete its data."
          onConfirm={handleArchive}
          onCancel={() => setArchiveModal(null)}
          confirming={confirming}
        />
      )}

      {deleteModal && (
        <ProjectActionConfirmModal
          title="Delete project"
          message="This will remove the project from the UI and delete all OpenSprint-related data from the project folder. Task data in the global store is not removed."
          onConfirm={handleDelete}
          onCancel={() => setDeleteModal(null)}
          confirming={confirming}
        />
      )}

      {apiKeyModalRoute && (
        <ApiKeySetupModal
          onComplete={() => {
            setApiKeyModalRoute(null);
            navigate(apiKeyModalRoute);
          }}
          onCancel={() => setApiKeyModalRoute(null)}
          intendedRoute={apiKeyModalRoute}
        />
      )}

      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-4 right-4 text-xs text-theme-muted/50 hover:text-theme-muted transition-colors"
        data-testid="github-link"
      >
        GitHub
      </a>
    </Layout>
  );
}
