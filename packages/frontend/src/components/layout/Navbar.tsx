import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Project, ProjectPhase } from "@opensprint/shared";
import { getProjectPhasePath } from "../../lib/phaseRouting";
import { api } from "../../api/client";
import { ActiveAgentsList } from "../ActiveAgentsList";
import { ConnectionIndicator } from "../ConnectionIndicator";
import { ProjectSettingsModal } from "../ProjectSettingsModal";

interface NavbarProps {
  project?: Project | null;
  currentPhase?: ProjectPhase;
  onPhaseChange?: (phase: ProjectPhase) => void;
  onProjectSaved?: () => void;
  /** When provided, settings modal is controlled by parent */
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
}

const phases: { key: ProjectPhase; label: string }[] = [
  { key: "sketch", label: "Sketch" },
  { key: "plan", label: "Plan" },
  { key: "execute", label: "Execute" },
  { key: "eval", label: "Eval" },
  { key: "deliver", label: "Deliver" },
];

export function Navbar({
  project,
  currentPhase,
  onPhaseChange,
  onProjectSaved,
  settingsOpen: controlledSettingsOpen,
  onSettingsOpenChange,
}: NavbarProps) {
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [internalSettingsOpen, setInternalSettingsOpen] = useState(false);
  const settingsOpen = controlledSettingsOpen ?? internalSettingsOpen;
  const setSettingsOpen = onSettingsOpenChange ?? setInternalSettingsOpen;
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (dropdownOpen) {
      api.projects
        .list()
        .then(setProjects)
        .catch(console.error);
    }
  }, [dropdownOpen]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [dropdownOpen]);

  return (
    <nav className="relative z-[60] bg-white border-b border-gray-200 px-6 py-3">
      <div className="flex items-center justify-between">
        {/* Left: Logo + Project Selector */}
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">OS</span>
            </div>
            <span className="font-semibold text-lg text-gray-900">OpenSprint</span>
          </Link>

          <div className="relative flex items-center" ref={dropdownRef}>
            <span className="text-gray-300">/</span>
            <button
              type="button"
              onClick={() => setDropdownOpen((o) => !o)}
              className="ml-1 inline-flex items-center gap-1 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors rounded px-2 py-1 hover:bg-gray-100"
              aria-expanded={dropdownOpen}
              aria-haspopup="listbox"
            >
              {project ? project.name : "All Projects"}
              <svg
                className={`w-4 h-4 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {dropdownOpen && (
              <div
                className="absolute left-0 top-full mt-1 min-w-[200px] max-h-[280px] overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50"
                role="listbox"
              >
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={p.id === project?.id}
                    onClick={() => {
                      setDropdownOpen(false);
                      navigate(getProjectPhasePath(p.id, currentPhase ?? "sketch"));
                    }}
                    className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors ${
                      p.id === project?.id ? "bg-brand-50 text-brand-700 font-medium" : "text-gray-700"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
                {projects.length === 0 && <div className="px-4 py-3 text-sm text-gray-500">No projects</div>}
                <div className="border-t border-gray-100 mt-1 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setDropdownOpen(false);
                      navigate("/projects/new");
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-brand-600 hover:bg-brand-50 font-medium"
                  >
                    + Create New Project
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Center: Phase Tabs */}
        {project && currentPhase && onPhaseChange && (
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            {phases.map((phase) => (
              <button
                key={phase.key}
                onClick={() => onPhaseChange(phase.key)}
                className={`phase-tab ${currentPhase === phase.key ? "phase-tab-active" : "phase-tab-inactive"}`}
              >
                {phase.label}
              </button>
            ))}
          </div>
        )}

        {/* Right: Active agents + Status + Settings */}
        <div className="flex items-center gap-3">
          {project && (
            <>
              <ActiveAgentsList projectId={project.id} />
              <ConnectionIndicator />
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                aria-label="Project settings"
                title="Project settings"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                  />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {settingsOpen && project && (
        <ProjectSettingsModal
          project={project}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            onProjectSaved?.();
          }}
        />
      )}
    </nav>
  );
}
