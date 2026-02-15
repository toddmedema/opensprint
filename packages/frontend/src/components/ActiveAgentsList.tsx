import { useState, useEffect, useRef, useCallback } from 'react';
import type { ActiveAgent } from '@opensprint/shared';
import { api } from '../api/client';

const POLL_INTERVAL_MS = 5000;

interface ActiveAgentsListProps {
  projectId: string;
}

export function ActiveAgentsList({ projectId }: ActiveAgentsListProps) {
  const [agents, setAgents] = useState<ActiveAgent[]>([]);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api.agents.active(projectId);
      setAgents(Array.isArray(data) ? data : []);
    } catch {
      setAgents([]);
    }
  }, [projectId]);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const phaseLabel = (phase: string) => {
    const m: Record<string, string> = {
      design: 'Design',
      plan: 'Plan',
      build: 'Build',
      validate: 'Validate',
      coding: 'Coding',
      review: 'Review',
    };
    return m[phase] ?? phase;
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-700 transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Active agents"
      >
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" aria-hidden />
        <span>
          {agents.length > 0
            ? `${agents.length} agent${agents.length === 1 ? '' : 's'} running`
            : 'No agents running'}
        </span>
        <svg
          className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 min-w-[220px] max-h-[320px] overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-2 z-50"
          role="listbox"
        >
          {agents.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-500">
              No agents running
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {agents.map((agent) => (
                <li
                  key={agent.id}
                  className="px-4 py-2.5 text-sm"
                  role="option"
                >
                  <div className="font-medium text-gray-900">{agent.label || agent.id}</div>
                  <div className="text-gray-500 mt-0.5">{phaseLabel(agent.phase)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
