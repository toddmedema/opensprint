import { Suspense, lazy, type ReactNode } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { Home } from "./pages/Home";
import { OnboardingPage } from "./pages/OnboardingPage";
import { ProjectSetup } from "./pages/ProjectSetup";
import { CreateNewProjectPage } from "./pages/CreateNewProjectPage";
import { ProjectShell } from "./pages/ProjectShell";
import { ProjectView } from "./pages/ProjectView";
import { GlobalKeyboardShortcuts } from "./components/GlobalKeyboardShortcuts";
import { FindBar } from "./components/FindBar";
import { CommandBar } from "./components/commands/CommandBar";
import { RouteFallback } from "./components/RouteFallback";
import { AccessGate } from "./components/AccessGate";
const CollaborationPage = lazy(() =>
  import("./pages/CollaborationPage").then((module) => ({ default: module.CollaborationPage }))
);
const SpecPublicationPage = lazy(() =>
  import("./pages/SpecPublicationPage").then((module) => ({ default: module.SpecPublicationPage }))
);

const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage }))
);
const HelpPage = lazy(() =>
  import("./pages/HelpPage").then((module) => ({ default: module.HelpPage }))
);
const ProjectSettingsContent = lazy(() =>
  import("./pages/ProjectSettingsContent").then((module) => ({
    default: module.ProjectSettingsContent,
  }))
);
const ProjectHelpContent = lazy(() =>
  import("./pages/ProjectHelpContent").then((module) => ({
    default: module.ProjectHelpContent,
  }))
);

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/** Redirects /help/shortcuts to /help?tab=shortcuts (or project help equivalent). */
function HelpShortcutsRedirect() {
  const { projectId } = useParams<{ projectId: string }>();
  if (projectId) {
    return <Navigate to={`/projects/${projectId}/help?tab=shortcuts`} replace />;
  }
  return <Navigate to="/help?tab=shortcuts" replace />;
}

export function App() {
  return (
    <AccessGate>
      <FindBar />
      <CommandBar />
      <GlobalKeyboardShortcuts />
      <Routes>
        <Route
          path="/collaborate/:projectId"
          element={
            <LazyRoute>
              <CollaborationPage />
            </LazyRoute>
          }
        />
        <Route path="/" element={<Home />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route
          path="/settings"
          element={
            <LazyRoute>
              <SettingsPage />
            </LazyRoute>
          }
        />
        <Route path="/help/shortcuts" element={<HelpShortcutsRedirect />} />
        <Route
          path="/help"
          element={
            <LazyRoute>
              <HelpPage />
            </LazyRoute>
          }
        />
        <Route path="/projects/add-existing" element={<ProjectSetup />} />
        <Route path="/projects/create-new" element={<CreateNewProjectPage />} />
        <Route path="/projects/:projectId" element={<ProjectShell />}>
          <Route
            path="publication"
            element={
              <LazyRoute>
                <SpecPublicationPage />
              </LazyRoute>
            }
          />
          <Route index element={<Navigate to="sketch" replace />} />
          <Route path="help/shortcuts" element={<HelpShortcutsRedirect />} />
          <Route
            path="help"
            element={
              <LazyRoute>
                <ProjectHelpContent />
              </LazyRoute>
            }
          />
          <Route
            path="settings"
            element={
              <LazyRoute>
                <ProjectSettingsContent />
              </LazyRoute>
            }
          />
          <Route path=":phase" element={<ProjectView />} />
        </Route>
      </Routes>
    </AccessGate>
  );
}
