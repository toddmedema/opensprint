import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { ProjectSetup } from "./pages/ProjectSetup";
import { CreateNewProjectPage } from "./pages/CreateNewProjectPage";
import { ProjectShell } from "./pages/ProjectShell";
import { ProjectView } from "./pages/ProjectView";
import { GlobalKeyboardShortcuts } from "./components/GlobalKeyboardShortcuts";
import { useAppDispatch } from "./store";
import { setRoute } from "./store/slices/routeSlice";

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

/** Clears route state when not viewing a project (home, settings, help, or project create/setup). */
function RouteSync() {
  const location = useLocation();
  const dispatch = useAppDispatch();
  useEffect(() => {
    const pathname = location.pathname;
    const isProjectView = /^\/projects\/(?!create-new|add-existing)([^/]+)/.test(pathname);
    if (!isProjectView) {
      dispatch(setRoute({ projectId: null, phase: null }));
    }
  }, [location.pathname, dispatch]);
  return null;
}

export function App() {
  return (
    <>
      <RouteSync />
      <GlobalKeyboardShortcuts />
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
    </>
  );
}
