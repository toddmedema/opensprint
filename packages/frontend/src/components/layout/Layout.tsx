import type { ReactNode } from 'react';
import type { Project, ProjectPhase } from '@opensprint/shared';
import { Navbar } from './Navbar';
import { NotificationBar } from '../NotificationBar';

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
    <div className="h-full flex flex-col bg-theme-surface">
      <Navbar
        project={project}
        currentPhase={currentPhase}
        onPhaseChange={onPhaseChange}
        onProjectSaved={onProjectSaved}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={onSettingsOpenChange}
      />
      <NotificationBar />
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-theme-surface">{children}</main>
    </div>
  );
}
