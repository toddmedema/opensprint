import type { ProjectPhase } from "@opensprint/shared";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Layout } from "../components/layout/Layout";
import { ProjectSettingsModal } from "../components/ProjectSettingsModal";
import { useProject } from "../api/hooks";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { queryKeys } from "../api/queryKeys";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Full-screen Project Settings page. Replaces the ProjectSettingsModal for project view.
 */
export function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: project, isLoading, error } = useProject(projectId);

  const handleClose = () => {
    navigate(projectId ? getProjectPhasePath(projectId, "sketch") : "/");
  };

  const handleSaved = () => {
    if (projectId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    }
    handleClose();
  };

  const handlePhaseChange = (phase: ProjectPhase) => {
    navigate(getProjectPhasePath(projectId!, phase));
  };

  if (!projectId) return null;
  if (isLoading && !project) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-full text-theme-muted">
          Loading project...
        </div>
      </Layout>
    );
  }
  if (error || !project) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center h-full gap-2 text-theme-muted">
          <p>Project not found or failed to load.</p>
          <Link to="/" className="text-brand-600 hover:text-brand-700 font-medium">
            Return to home
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      project={project}
      currentPhase="sketch"
      onPhaseChange={handlePhaseChange}
    >
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col px-6 py-6" data-testid="project-settings-page">
        <ProjectSettingsModal
          project={project}
          onClose={handleClose}
          onSaved={handleSaved}
          fullScreen
        />
      </div>
    </Layout>
  );
}
