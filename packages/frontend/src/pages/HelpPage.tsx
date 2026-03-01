import type { ProjectPhase } from "@opensprint/shared";
import { Link, useParams, useNavigate } from "react-router-dom";
import { Layout } from "../components/layout/Layout";
import { HelpContent } from "../components/HelpContent";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { useProject } from "../api/hooks";

/**
 * Full-screen Help page. Used for homepage (/help) and project view (/projects/:projectId/help).
 */
export function HelpPage() {
  const { projectId } = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const { data: project } = useProject(projectId);

  const backTo = projectId ? getProjectPhasePath(projectId, "sketch") : "/";
  const projectContext = project ? { id: project.id, name: project.name } : undefined;

  const handlePhaseChange = (phase: ProjectPhase) => {
    if (projectId) navigate(getProjectPhasePath(projectId, phase));
  };

  return (
    <Layout
      project={project}
      currentPhase={projectId ? "sketch" : undefined}
      onPhaseChange={projectId ? handlePhaseChange : undefined}
    >
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-testid="help-page">
        <div className="max-w-4xl mx-auto w-full px-6 py-6 flex flex-col min-h-0">
          <div className="flex items-center gap-4 mb-4 shrink-0">
            <Link
              to={backTo}
              className="p-2 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
              aria-label="Back"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </Link>
            <h1 className="text-2xl font-semibold text-theme-text">Help</h1>
          </div>
          <div className="flex-1 min-h-0 flex flex-col bg-theme-surface rounded-xl border border-theme-border overflow-hidden">
            <div className="px-6 pt-4">
              <HelpContent project={projectContext} />
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
