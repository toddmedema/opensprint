import type { ReactNode } from "react";
import type { Project, ProjectPhase } from "@opensprint/shared";
import { Navbar } from "./Navbar";
import { NotificationBar } from "../NotificationBar";
import { ConnectionErrorBanner } from "../ConnectionErrorBanner";
import { DatabaseStatusBanner } from "../DatabaseStatusBanner";

interface LayoutProps {
  children: ReactNode;
  project?: Project | null;
  currentPhase?: ProjectPhase;
  onPhaseChange?: (phase: ProjectPhase) => void;
  onProjectSaved?: () => void;
}

export function Layout({
  children,
  project,
  currentPhase,
  onPhaseChange,
  onProjectSaved,
}: LayoutProps) {
  return (
    <div className="h-full flex flex-col bg-theme-bg">
      <ConnectionErrorBanner />
      <DatabaseStatusBanner />
      <Navbar
        project={project}
        currentPhase={currentPhase}
        onPhaseChange={onPhaseChange}
        onProjectSaved={onProjectSaved}
      />
      <NotificationBar />
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-theme-bg">{children}</main>
    </div>
  );
}
