import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, type ChangeEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { ApiError, getHome, getProject, getSession, queryKeys, signOut } from "./api";
import { useProjectEvents } from "./events";
import { cap } from "./text";
import { ErrorNote, PageHeading } from "./ui";
import { useVocabulary } from "./vocabulary";

export function SprintMark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 80 80"
      width={32}
      height={32}
      aria-hidden="true"
    >
      <polygon points="4,10 36,40 4,70" fill="#d8d8de" />
      <polygon points="22,10 54,40 22,70" fill="#a1a1aa" />
      <polygon points="40,10 72,40 40,70" fill="#0071e3" />
    </svg>
  );
}

function projectSections(projectId: string, frameLabel: string) {
  return [
    { id: "frame", label: frameLabel, to: `/p/${projectId}/frame` },
    { id: "order", label: "Order", to: `/p/${projectId}/order` },
    { id: "gate", label: "Gate", to: `/p/${projectId}/gate` },
    { id: "evolve", label: "Evolve", to: `/p/${projectId}/evolve` },
  ];
}

function SectionLinks({ projectId, frameLabel }: { projectId: string; frameLabel: string }) {
  return (
    <div className="section-links">
      {projectSections(projectId, frameLabel).map((section) => (
        <NavLink key={section.id} to={section.to} className="nav-link">
          {section.label}
        </NavLink>
      ))}
    </div>
  );
}

function SectionMenu({ projectId, frameLabel }: { projectId: string; frameLabel: string }) {
  const location = useLocation();
  const currentId = location.pathname.split("/").filter(Boolean)[2] ?? "frame";
  const sections = projectSections(projectId, frameLabel);
  const current = sections.find((section) => section.id === currentId) ?? sections[0];
  if (!current) return null;
  return (
    <details className="section-menu">
      <summary aria-current="page">{current.label}</summary>
      <div className="section-menu-list">
        {sections
          .filter((section) => section.id !== current.id)
          .map((section) => (
            <NavLink key={section.id} to={section.to} className="nav-link">
              {section.label}
            </NavLink>
          ))}
      </div>
    </details>
  );
}

function liveLabel(live: ReturnType<typeof useProjectEvents>): string | null {
  if (live === "reconnecting") return "Live updates: reconnecting.";
  if (live === "connecting") return "Live updates: connecting.";
  return null;
}

export function Shell() {
  const { names } = useVocabulary();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const match = useMatch("/p/:projectId/*");
  const projectId = match?.params.projectId;
  const selectId = useId();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: getSession });
  const home = useQuery({ queryKey: queryKeys.home, queryFn: getHome });
  const project = useQuery({
    queryKey: queryKeys.project(projectId ?? ""),
    queryFn: () => getProject(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const missing = project.error instanceof ApiError && project.error.status === 404;
  const live = useProjectEvents(projectId && !missing ? projectId : undefined);
  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.setQueryData(queryKeys.session, null);
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== "session",
      });
      navigate("/");
    },
  });

  const projects = home.data?.projects ?? [];
  const loadedName = project.data?.project.name ?? "";
  const projectName =
    project.data?.project.name ?? (project.isPending ? "Loading project…" : projectId);
  const liveMessage = liveLabel(live);

  function openProject(event: ChangeEvent<HTMLSelectElement>) {
    const nextId = event.target.value;
    const section = location.pathname.split("/").filter(Boolean)[2];
    const safe =
      section === "frame" || section === "gate" || section === "evolve" || section === "order"
        ? section
        : "frame";
    navigate(`/p/${nextId}/${safe}`);
  }

  return (
    <div className="shell">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <header className="topbar">
        <nav className="bar" aria-label="Forge">
          <div className="bar-start">
            <Link to="/" className="logo-link" aria-label="Home">
              <SprintMark />
            </Link>
            {projectId && loadedName.trim() ? (
              <p className="bar-project" title={loadedName}>
                {loadedName}
              </p>
            ) : null}
          </div>
          <div className="bar-center">
            {projectId ? (
              <>
                <SectionLinks projectId={projectId} frameLabel={cap(names.frame)} />
                <SectionMenu projectId={projectId} frameLabel={cap(names.frame)} />
              </>
            ) : null}
          </div>
          <div className="bar-end">
            <NavLink to="/" end className="nav-link">
              Home
            </NavLink>
            <NavLink to="/people" className="nav-link">
              People
            </NavLink>
            <details className="account">
              <summary>Account</summary>
              <div className="stack">
                <p className="account-note">Signed in as {session.data?.name ?? "this user"}.</p>
                {projectId && projects.length > 1 ? (
                  <div className="field rail-field">
                    <label htmlFor={selectId}>Open {cap(names.project)}</label>
                    <select id={selectId} value={projectId} onChange={openProject}>
                      {projects.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                      {projects.some((item) => item.id === projectId) ? null : (
                        <option value={projectId}>{projectName}</option>
                      )}
                    </select>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="quiet"
                  onClick={() => signOutMutation.mutate()}
                  disabled={signOutMutation.isPending}
                >
                  {signOutMutation.isPending ? "Signing out…" : "Sign out"}
                </button>
                <ErrorNote error={signOutMutation.error} />
              </div>
            </details>
          </div>
        </nav>
      </header>
      <main className="content" id="content" tabIndex={-1}>
        {liveMessage ? (
          <p className="live" role="status">
            {liveMessage}
          </p>
        ) : null}
        {projectId && project.isError && !missing ? <ErrorNote error={project.error} /> : null}
        {missing ? (
          <section className="stack">
            <PageHeading kicker={cap(names.project)} title="Project not found" />
            <p>This project is not on the server.</p>
            <NavLink to="/">Back to home</NavLink>
          </section>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
