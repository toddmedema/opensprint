import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Layout } from "./layout/Layout";
import { api } from "../api/client";
import { getProjectPhasePath } from "../lib/phaseRouting";
import type { Project } from "@opensprint/shared";

const PHASE_LABELS: Record<string, string> = {
  spec: "Spec",
  plan: "Plan",
  execute: "Execute",
  eval: "Eval",
  deliver: "Deliver",
};

function ProjectCard({ project }: { project: Project }) {
  const phaseLabel = PHASE_LABELS[project.currentPhase] ?? project.currentPhase;
  const progress = project.progressPercent ?? 0;

  return (
    <Link to={getProjectPhasePath(project.id, project.currentPhase)} className="card p-8 hover:shadow-md transition-shadow group block">
      <h3 className="font-semibold text-gray-900 group-hover:text-brand-600 transition-colors">{project.name}</h3>
      {project.description && <p className="mt-1 text-sm text-gray-500 line-clamp-2">{project.description}</p>}
      <div className="mt-3 flex items-center justify-between">
        <span className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
          {phaseLabel}
        </span>
        <span className="text-xs text-gray-400">{new Date(project.updatedAt).toLocaleDateString()}</span>
      </div>
      {progress > 0 && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-brand-600 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </Link>
  );
}

export function HomeScreen() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.projects
      .list()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <Layout>
      <div className="max-w-6xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
            <p className="mt-1 text-gray-500">Manage your AI-powered development projects</p>
          </div>
          <button onClick={() => navigate("/projects/new")} className="btn-primary">
            Create New Project
          </button>
        </div>

        {/* Project Grid */}
        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gray-100 flex items-center justify-center">
              <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-1">No projects yet</h3>
            <p className="text-gray-500 mb-6">Get started by creating your first project</p>
            <button onClick={() => navigate("/projects/new")} className="btn-primary">
              Create New Project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 lg:gap-12">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
