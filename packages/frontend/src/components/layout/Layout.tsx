import type { ReactNode } from 'react';
import type { Project, ProjectPhase } from '@opensprint/shared';
import { Navbar } from './Navbar';

interface LayoutProps {
  children: ReactNode;
  project?: Project | null;
  currentPhase?: ProjectPhase;
  onPhaseChange?: (phase: ProjectPhase) => void;
  onProjectSaved?: () => void;
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
}

export function Layout({
  children,
  project,
  currentPhase,
  onPhaseChange,
  onProjectSaved,
  settingsOpen,
  onSettingsOpenChange,
}: LayoutProps) {
  return (
    <div className="h-full flex flex-col bg-white">
      <Navbar
        project={project}
        currentPhase={currentPhase}
        onPhaseChange={onPhaseChange}
        onProjectSaved={onProjectSaved}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={onSettingsOpenChange}
      />
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-white">{children}</main>
    </div>
  );
}
