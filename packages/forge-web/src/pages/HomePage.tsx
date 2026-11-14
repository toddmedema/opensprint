import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createProject,
  createTeam,
  getHealth,
  getHome,
  queryKeys,
  type CreateProjectInput,
  type CredentialInput,
  type HomeData,
  type ProjectSummary,
} from "../api";
import { cap, linesToList, plural } from "../text";
import { ErrorNote, Loading, Notice, PageHeading } from "../ui";
import { useVocabulary } from "../vocabulary";

export function HomePage() {
  const [preferredTeamId, setPreferredTeamId] = useState<string | null>(null);
  const home = useQuery({ queryKey: queryKeys.home, queryFn: getHome });
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: getHealth,
    refetchInterval: 20_000,
  });

  return (
    <div className="stack">
      <PageHeading
        kicker="Home"
        title="Open Sprint Forge"
        lead="Name the work, then run it with your team."
      />
      {health.isError ? <p role="status">The server is not responding.</p> : null}
      {home.isError ? <ErrorNote error={home.error} /> : null}
      {home.isPending ? <Loading>Loading home…</Loading> : null}
      {home.data && home.data.teams.length === 0 ? (
        <CreateTeamForm onCreated={setPreferredTeamId} />
      ) : null}
      {home.data ? <StartForm data={home.data} preferredTeamId={preferredTeamId} /> : null}
      {home.data && home.data.projects.length > 0 ? (
        <ProjectList projects={home.data.projects} />
      ) : null}
      {home.data && home.data.recentShips.length > 0 ? (
        <ShipSection data={home.data} />
      ) : null}
    </div>
  );
}

function CreateTeamForm({ onCreated }: { onCreated: (teamId: string) => void }) {
  const queryClient = useQueryClient();
  const nameId = useId();
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => createTeam(name.trim()),
    onSuccess: async (team) => {
      setName("");
      setNotice(`Team ${team.name} created.`);
      onCreated(team.id);
      queryClient.setQueryData<HomeData>(queryKeys.home, (current) => {
        if (!current || current.teams.some((item) => item.id === team.id)) return current;
        return {
          ...current,
          teams: [...current.teams, { id: team.id, name: team.name, role: "admin" }],
        };
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
  });

  return (
    <form
      className="card form-narrow stack"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setNotice(null);
        mutation.mutate();
      }}
    >
      <h2>Create team</h2>
      <div className="field">
        <label htmlFor={nameId}>Team name</label>
        <input id={nameId} required value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <ErrorNote error={mutation.error} />
      <Notice>{notice}</Notice>
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Creating team…" : "Create team"}
      </button>
    </form>
  );
}

function StartForm({
  data,
  preferredTeamId,
}: {
  data: HomeData;
  preferredTeamId: string | null;
}) {
  const { names } = useVocabulary();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const base = useId();
  const setupRef = useRef<HTMLDetailsElement>(null);
  const [teamChoice, setTeamChoice] = useState<string | null>(preferredTeamId);
  const [origin, setOrigin] = useState<"scratch" | "import">("scratch");
  const [name, setName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [argvText, setArgvText] = useState("");
  const [timeoutSec, setTimeoutSec] = useState("600");
  const [credentialType, setCredentialType] = useState<"none" | "https_token">("none");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (preferredTeamId) setTeamChoice(preferredTeamId);
  }, [preferredTeamId]);

  const teamId =
    teamChoice && data.teams.some((team) => team.id === teamChoice)
      ? teamChoice
      : (data.teams[0]?.id ?? "");

  const mutation = useMutation({
    mutationFn: (input: { teamId: string; body: CreateProjectInput }) =>
      createProject(input.teamId, input.body),
    onSuccess: async (projectId) => {
      setName("");
      setRemoteUrl("");
      setArgvText("");
      setUsername("");
      setToken("");
      setCredentialType("none");
      setBaseBranch("main");
      setTimeoutSec("600");
      setNotice(
        projectId
          ? `${cap(names.project)} created.`
          : `${cap(names.project)} created. Open it from the list.`
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
      if (projectId) navigate(`/p/${projectId}/frame`);
    },
  });

  function openSetup() {
    if (setupRef.current) setupRef.current.open = true;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    const argv = linesToList(argvText);
    const timeout = Number(timeoutSec);
    if (!teamId) {
      setFormError("Create a team before adding a project.");
      return;
    }
    if (!name.trim()) {
      setFormError("Enter a project name.");
      return;
    }
    if (origin === "import" && (!remoteUrl.trim() || !baseBranch.trim())) {
      setFormError("Enter a name, remote URL, and base branch.");
      return;
    }
    if (origin === "import" && /^https:\/\//i.test(remoteUrl.trim()) && credentialType === "none") {
      setFormError("An HTTPS remote needs a token.");
      openSetup();
      return;
    }
    if (argv.length === 0) {
      setFormError("Enter the agent runtime. The first line is the program.");
      return;
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      setFormError("Enter a timeout greater than zero seconds.");
      openSetup();
      return;
    }
    if (credentialType === "https_token" && (!username.trim() || !token)) {
      setFormError("Enter the HTTPS username and token.");
      openSetup();
      return;
    }
    setFormError(null);
    const credential: CredentialInput =
      credentialType === "none"
        ? { type: "none" }
        : { type: "https_token", username: username.trim(), token };
    const agentRuntime = { argv, timeoutSec: timeout };
    const body: CreateProjectInput =
      origin === "scratch"
        ? {
            origin: "scratch",
            name: name.trim(),
            baseBranch: "main",
            agentRuntime,
            credential,
          }
        : {
            origin: "import",
            name: name.trim(),
            remoteUrl: remoteUrl.trim(),
            baseBranch: baseBranch.trim(),
            agentRuntime,
            credential,
          };
    mutation.mutate({ teamId, body });
  }

  const submitLabel = origin === "scratch" ? `Create ${names.project}` : "Import repository";

  return (
    <form className="card form-narrow stack" onSubmit={onSubmit}>
      <h2>Start</h2>
      {data.teams.length > 1 ? (
        <div className="field">
          <label htmlFor={`${base}-team`}>Team</label>
          <select
            id={`${base}-team`}
            value={teamId}
            onChange={(event) => setTeamChoice(event.target.value)}
          >
            {data.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="choices" role="group" aria-label="How to start">
        <button
          type="button"
          className="quiet"
          aria-pressed={origin === "scratch"}
          onClick={() => setOrigin("scratch")}
        >
          Start from scratch
        </button>
        <button
          type="button"
          className="quiet"
          aria-pressed={origin === "import"}
          onClick={() => setOrigin("import")}
        >
          Import a repository
        </button>
      </div>
      <div className="field">
        <label htmlFor={`${base}-name`}>Name</label>
        <input
          id={`${base}-name`}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {origin === "import" ? (
        <>
          <div className="field">
            <label htmlFor={`${base}-remote`}>Remote URL</label>
            <input
              id={`${base}-remote`}
              required
              spellCheck={false}
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${base}-branch`}>Base branch</label>
            <input
              id={`${base}-branch`}
              required
              spellCheck={false}
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
            />
          </div>
        </>
      ) : null}
      <div className="field">
        <label htmlFor={`${base}-argv`}>Runtime</label>
        <textarea
          id={`${base}-argv`}
          spellCheck={false}
          value={argvText}
          onChange={(event) => setArgvText(event.target.value)}
          aria-describedby={`${base}-argv-hint`}
        />
        <p className="hint" id={`${base}-argv-hint`}>
          The first line is the program. Forge does not assume a test command.
        </p>
      </div>
      <details ref={setupRef}>
        <summary>Timeout and credential</summary>
        <div className="stack">
          <div className="field">
            <label htmlFor={`${base}-timeout`}>Timeout (seconds)</label>
            <input
              id={`${base}-timeout`}
              type="number"
              value={timeoutSec}
              onChange={(event) => setTimeoutSec(event.target.value)}
            />
          </div>
          <fieldset>
            <legend>Credential</legend>
            <label className="choice">
              <input
                type="radio"
                name={`${base}-credential`}
                value="none"
                checked={credentialType === "none"}
                onChange={() => setCredentialType("none")}
              />
              <span>None</span>
            </label>
            <label className="choice">
              <input
                type="radio"
                name={`${base}-credential`}
                value="https_token"
                checked={credentialType === "https_token"}
                onChange={() => setCredentialType("https_token")}
              />
              <span>HTTPS token</span>
            </label>
          </fieldset>
          {credentialType === "https_token" ? (
            <>
              <div className="field">
                <label htmlFor={`${base}-user`}>Username</label>
                <input
                  id={`${base}-user`}
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor={`${base}-token`}>Token</label>
                <input
                  id={`${base}-token`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </div>
            </>
          ) : null}
        </div>
      </details>
      <ErrorNote error={formError ? new Error(formError) : mutation.error} />
      <Notice>{notice}</Notice>
      <button
        type="submit"
        className={data.teams.length === 0 ? "quiet" : undefined}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? "Starting…" : submitLabel}
      </button>
    </form>
  );
}

function ProjectList({ projects }: { projects: ProjectSummary[] }) {
  const { names } = useVocabulary();
  return (
    <section className="stack">
      <h2>{cap(plural(names.project))}</h2>
      <ul className="plain-list">
        {projects.map((project) => (
          <li key={project.id} className="list-card stack">
            <h3>
              <Link to={`/p/${project.id}/frame`}>{project.name}</Link>
            </h3>
            <p>{project.baseBranch}</p>
            <p>{runbookLine(project)}</p>
            {project.credentialKind === "https_token" ? <p>HTTPS credential stored.</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function runbookLine(project: ProjectSummary): string {
  if (project.runbookLocked) return "Runbook locked";
  if (project.activeRunbookDigest) return "Runbook ready";
  return "No runbook yet";
}

function ShipSection({ data }: { data: HomeData }) {
  return (
    <section className="stack">
      <h2>Recent ships</h2>
      <ul className="plain-list">
        {data.recentShips.map((ship) => {
          const project = data.projects.find((item) => item.id === ship.projectId);
          return (
            <li key={`${ship.projectId}-${ship.workItemId}`} className="list-card stack">
              <h3>
                <Link to={`/p/${ship.projectId}/order/${ship.workItemId}`}>{ship.title}</Link>
              </h3>
              <p>{project?.name ?? ship.projectId}</p>
              <p>{ship.updatedAt ? new Date(ship.updatedAt).toLocaleString() : "Time not reported"}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
