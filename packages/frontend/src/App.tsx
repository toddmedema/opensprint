import { Suspense, lazy, type ReactNode } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Home } from "./pages/Home";
import { ProjectSetup } from "./pages/ProjectSetup";
import { CreateNewProjectPage } from "./pages/CreateNewProjectPage";
import { ProjectShell } from "./pages/ProjectShell";
import { ProjectView } from "./pages/ProjectView";

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

function RouteFallback() {
  return (
    <div className="flex min-h-full items-center justify-center p-6 text-sm text-theme-muted">
      Loading...
    </div>
  );
}

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route
        path="/settings"
        element={
          <LazyRoute>
            <SettingsPage />
          </LazyRoute>
        }
      />
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
        <Route index element={<Navigate to="sketch" replace />} />
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
  );
}
