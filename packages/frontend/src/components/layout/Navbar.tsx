import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Project, ProjectPhase } from '@opensprint/shared';
import { api } from '../../api/client';
import { ActiveAgentsList } from '../ActiveAgentsList';

interface NavbarProps {
  project?: Project | null;
  currentPhase?: ProjectPhase;
  onPhaseChange?: (phase: ProjectPhase) => void;
}

const phases: { key: ProjectPhase; label: string }[] = [
  { key: 'design', label: 'Design' },
  { key: 'plan', label: 'Plan' },
  { key: 'build', label: 'Build' },
  { key: 'validate', label: 'Validate' },
];

export function Navbar({ project, currentPhase, onPhaseChange }: NavbarProps) {
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (dropdownOpen) {
      api.projects
        .list()
        .then((data) => setProjects(data as Project[]))
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
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [dropdownOpen]);

  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3">
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
              {project ? project.name : 'All Projects'}
              <svg
                className={`w-4 h-4 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}
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
                        navigate(`/projects/${p.id}`);
                      }}
                      className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors ${
                        p.id === project?.id ? 'bg-brand-50 text-brand-700 font-medium' : 'text-gray-700'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                  {projects.length === 0 && (
                    <div className="px-4 py-3 text-sm text-gray-500">No projects</div>
                  )}
                  <div className="border-t border-gray-100 mt-1 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setDropdownOpen(false);
                        navigate('/projects/new');
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
                className={`phase-tab ${
                  currentPhase === phase.key
                    ? 'phase-tab-active'
                    : 'phase-tab-inactive'
                }`}
              >
                {phase.label}
              </button>
            ))}
          </div>
        )}

        {/* Right: Active agents + Status */}
        <div className="flex items-center gap-3">
          {project && (
            <>
              <ActiveAgentsList projectId={project.id} />
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <span>Online</span>
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
