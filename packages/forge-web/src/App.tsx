import { useQuery } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useParams } from "react-router-dom";
import { AuthPanel } from "./AuthPanel";
import { getHealth, getSession, queryKeys } from "./api";
import { EvolvePage } from "./pages/EvolvePage";
import { FramePage } from "./pages/FramePage";
import { GatePage } from "./pages/GatePage";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { OrderPage } from "./pages/OrderPage";
import { PeoplePage } from "./pages/PeoplePage";
import { WorkRoomPage } from "./pages/WorkRoomPage";
import { Shell, SprintMark } from "./shell";
import { ErrorNote, Loading, PageHeading, Retry } from "./ui";
import { VocabularyProvider } from "./vocabulary";

export function App() {
  return (
    <BrowserRouter>
      <VocabularyProvider>
        <SessionGate />
      </VocabularyProvider>
    </BrowserRouter>
  );
}

function SessionGate() {
  const session = useQuery({ queryKey: queryKeys.session, queryFn: getSession });
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: getHealth,
    refetchInterval: 20_000,
  });

  if (session.isPending) {
    return (
      <div className="gate">
        <main className="gate-inner">
          <Loading>Checking session…</Loading>
        </main>
      </div>
    );
  }

  if (session.isError) {
    return (
      <div className="gate">
        <main className="gate-inner stack">
          <PageHeading kicker="Open Sprint" title="Forge" />
          <ErrorNote error={session.error} />
          <Retry onRetry={() => void session.refetch()} pending={session.isRefetching} />
        </main>
      </div>
    );
  }

  if (!session.data) {
    return (
      <div className="gate">
        <main className="gate-inner stack">
          <SprintMark />
          <header className="page-heading">
            <p className="kicker">Open Sprint</p>
            <h1>Forge</h1>
            <p className="lead">
              A self-hosted room for a team to frame work, order it, gate it, and evolve the rules.
            </p>
          </header>
          {health.isError ? <p role="status">The server is not responding.</p> : null}
          <AuthPanel />
        </main>
      </div>
    );
  }

  return <AuthedRoutes />;
}

function AuthedRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/p/:projectId" element={<ProjectScope />}>
          <Route index element={<Navigate to="frame" replace />} />
          <Route path="frame" element={<FramePage />} />
          <Route path="order" element={<OrderPage />} />
          <Route path="order/:workItemId" element={<WorkRoomPage />} />
          <Route path="gate" element={<GatePage />} />
          <Route path="evolve" element={<EvolvePage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function ProjectScope() {
  const { projectId } = useParams();
  return <Outlet key={projectId} />;
}

function NotFound() {
  return (
    <section className="stack">
      <PageHeading kicker="Forge" title="Page not found" lead="This address is outside Forge." />
    </section>
  );
}
