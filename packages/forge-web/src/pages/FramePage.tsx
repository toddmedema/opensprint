import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import {
  discoverRunbook,
  getFrame,
  getGate,
  getProject,
  getRunbook,
  invalidateProject,
  lockRunbook,
  probeVerification,
  proposeRunbook,
  queryKeys,
  saveFrame,
  type Ack,
} from "../api";
import { asRecord, cap, formatProbe, formatWhen, parseJsonObject, prettyJson, str } from "../text";
import {
  AckNote,
  Empty,
  ErrorNote,
  Loading,
  Notice,
  PageHeading,
  StatusTag,
  VerificationCommandField,
} from "../ui";
import { useVocabulary } from "../vocabulary";

export function FramePage() {
  const { projectId = "" } = useParams();
  const { names } = useVocabulary();
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => getProject(projectId),
  });
  const frame = useQuery({
    queryKey: queryKeys.frame(projectId),
    queryFn: () => getFrame(projectId),
  });
  const runbook = useQuery({
    queryKey: queryKeys.runbook(projectId),
    queryFn: () => getRunbook(projectId),
  });
  const gate = useQuery({
    queryKey: queryKeys.gate(projectId),
    queryFn: () => getGate(projectId),
  });
  const [draft, setDraft] = useState<{ text: string; baseVersion: number } | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [lockNotice, setLockNotice] = useState<string | null>(null);
  const [documentText, setDocumentText] = useState("");
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [discoverAck, setDiscoverAck] = useState<Ack | null>(null);
  const [proposalAck, setProposalAck] = useState<Ack | null>(null);
  const [command, setCommand] = useState("");
  const [probeAck, setProbeAck] = useState<Ack | null>(null);

  const markdown = draft?.text ?? frame.data?.markdown ?? "";
  const locked = runbook.data?.locked ?? false;
  const digest =
    runbook.data?.activeDigest ??
    project.data?.runbook?.activeDigest ??
    project.data?.project.activeRunbookDigest ??
    null;
  const activeDocument = runbook.data?.active ?? project.data?.runbook?.document ?? null;
  const verificationArgv = commandArgv(activeDocument);
  const known = runbook.isSuccess || project.isSuccess;
  const rejected = [...(runbook.data?.revisions ?? [])]
    .reverse()
    .find((revision) => revision.status === "rejected");
  const discoveryQuestions = uniqueQuestions([
    ...(gate.data?.questions ?? [])
      .filter((question) => question.role === "discovery")
      .map((question) => question.prompt),
    ...(discoverAck?.questions ?? []),
  ]);

  const save = useMutation({
    mutationFn: (next: string) => saveFrame(projectId, next),
    onSuccess: async (saved) => {
      setDraft(null);
      setSaveNotice(`Saved version ${saved.version}.`);
      await invalidateProject(projectId);
    },
  });
  const discover = useMutation({
    mutationFn: () => discoverRunbook(projectId),
    onSuccess: async (ack) => {
      setDiscoverAck(ack);
      await invalidateProject(projectId);
    },
  });
  const probe = useMutation({
    mutationFn: (text: string) => probeVerification(projectId, text),
    onSuccess: async (ack) => {
      setProbeAck(ack);
      if (ack.outcome === "active") setDiscoverAck(null);
      await invalidateProject(projectId);
    },
  });
  const propose = useMutation({
    mutationFn: (document: Record<string, unknown>) => proposeRunbook(projectId, document),
    onSuccess: async (ack) => {
      setProposalAck(ack);
      await invalidateProject(projectId);
    },
  });
  const lock = useMutation({
    mutationFn: (next: boolean) => lockRunbook(projectId, next),
    onSuccess: async (_result, next) => {
      setLockNotice(next ? `${cap(names.runbook)} locked.` : `${cap(names.runbook)} unlocked.`);
      await invalidateProject(projectId);
    },
  });

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveNotice(null);
    save.mutate(markdown);
  }

  function onProbe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProbeAck(null);
    probe.mutate(command.trim());
  }

  function onPropose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProposalAck(null);
    try {
      const document = parseJsonObject(documentText);
      setDocumentError(null);
      propose.mutate(document);
    } catch (error) {
      setDocumentError(error instanceof Error ? error.message : "Proposal document must be JSON.");
    }
  }

  const showRejection = !digest && (probeAck?.outcome === "rejected" || Boolean(rejected));
  const frameLead = !known
    ? undefined
    : !digest
      ? "Probe a verification command, then write the frame."
      : markdown.trim()
        ? undefined
        : "Write what the project is.";

  return (
    <div className="stack">
      <PageHeading
        kicker={cap(names.frame)}
        title={project.data?.project.name ?? cap(names.frame)}
        lead={frameLead}
      />
      {known && digest && verificationArgv.length > 0 ? (
        <p>Verification is {verificationArgv.join(" ")}.</p>
      ) : null}
      {known && !digest ? (
        <form className="card stack" onSubmit={onProbe}>
          {discoveryQuestions.map((question) => (
            <p key={question}>{question}</p>
          ))}
          <VerificationCommandField id="verification-command" value={command} onChange={setCommand} />
          {showRejection ? (
            <div className="stack">
              <p className="keep-breaks">{formatProbe(rejected?.probe)}</p>
              <p>The probe did not pass, so no runbook is active.</p>
            </div>
          ) : null}
          <ErrorNote error={probe.error} />
          <button type="submit" disabled={probe.isPending}>
            {probe.isPending ? "Probing…" : "Probe verification"}
          </button>
        </form>
      ) : null}
      {frame.isPending ? <Loading>{`Loading ${names.frame}…`}</Loading> : null}
      {frame.isError ? <ErrorNote error={frame.error} /> : null}
      <form className="card stack" onSubmit={onSave}>
        <div className="field">
          <label htmlFor="frame-markdown">{cap(names.frame)}</label>
          <textarea
            id="frame-markdown"
            className="editor"
            value={markdown}
            onChange={(event) =>
              setDraft({
                text: event.target.value,
                baseVersion: draft?.baseVersion ?? frame.data?.version ?? 0,
              })
            }
          />
        </div>
        {!markdown.trim() ? (
          <Empty>This frame has no markdown yet. Write the intent and save.</Empty>
        ) : null}
        {draft && frame.data && frame.data.version !== draft.baseVersion ? (
          <p role="status">
            The saved frame changed while this draft was open. Saving sends the draft as the next
            version.
          </p>
        ) : null}
        <p>
          Editing version {draft?.baseVersion ?? frame.data?.version ?? 0}.
          {draft ? " Unsaved changes." : " Saved text is showing."}
        </p>
        <ErrorNote error={save.error} />
        <Notice>{saveNotice}</Notice>
        <button type="submit" className={digest ? undefined : "quiet"} disabled={save.isPending}>
          {save.isPending ? "Saving…" : `Save ${names.frame}`}
        </button>
      </form>
      <section className="card stack">
        <h2>Versions</h2>
        {frame.data && frame.data.versions.length === 0 ? (
          <Empty>No saved versions yet.</Empty>
        ) : (
          <ul>
            {frame.data?.versions.map((version) => (
              <li key={version.version}>
                Version {version.version}, {formatWhen(version.createdAt)}
                {version.version === frame.data?.version ? " (current)" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card stack">
        <h2>{cap(names.runbook)}</h2>
        {runbook.isPending ? <Loading>{`Loading ${names.runbook}…`}</Loading> : null}
        {runbook.isError ? <ErrorNote error={runbook.error} /> : null}
        {digest ? <p className="mono">Digest: {digest}</p> : null}
        <Notice>{lockNotice}</Notice>
        <ErrorNote error={lock.error} />
        <button
          type="button"
          className="quiet"
          disabled={lock.isPending || !runbook.isSuccess || (!locked && !digest)}
          onClick={() => {
            setLockNotice(null);
            lock.mutate(!locked);
          }}
        >
          {lock.isPending
            ? "Updating lock…"
            : locked
              ? `Unlock ${names.runbook}`
              : `Lock ${names.runbook}`}
        </button>
        <div className="actions">
          <button
            type="button"
            className="quiet"
            disabled={discover.isPending}
            onClick={() => {
              setDiscoverAck(null);
              discover.mutate();
            }}
          >
            {discover.isPending ? "Discovering…" : `Discover ${names.runbook}`}
          </button>
        </div>
        <ErrorNote error={discover.error} />
        {discoverAck && discoverAck.questions.length > 0 ? null : <AckNote ack={discoverAck} />}
        {runbook.data?.active != null ? (
          <details>
            <summary>Active {names.runbook} document</summary>
            <pre className="exact">{prettyJson(runbook.data.active) || "Empty document."}</pre>
          </details>
        ) : null}
        <h3>Revisions</h3>
        {runbook.data && runbook.data.revisions.length === 0 ? (
          <Empty>No revisions yet. Discover a runbook to record one.</Empty>
        ) : (
          <ul className="plain-list">
            {runbook.data?.revisions.map((revision) => (
              <li key={revision.id} className="list-card">
                <p className="mono">{revision.digest || revision.id}</p>
                <p>
                  <StatusTag status={revision.status} /> {formatWhen(revision.createdAt)}
                </p>
                <p className="keep-breaks">{formatProbe(revision.probe)}</p>
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary>Submit a runbook document</summary>
          <form className="stack" onSubmit={onPropose}>
            <div className="field">
              <label htmlFor="runbook-proposal">Proposal document (JSON)</label>
              <textarea
                id="runbook-proposal"
                spellCheck={false}
                value={documentText}
                onChange={(event) => setDocumentText(event.target.value)}
              />
            </div>
            <ErrorNote error={documentError ? new Error(documentError) : propose.error} />
            <AckNote ack={proposalAck} />
            <button type="submit" className="quiet" disabled={propose.isPending}>
              {propose.isPending ? "Submitting proposal…" : "Submit proposal"}
            </button>
          </form>
        </details>
      </section>
    </div>
  );
}

function uniqueQuestions(questions: string[]): string[] {
  return [...new Set(questions.map((question) => question.trim()).filter(Boolean))];
}

function commandArgv(document: unknown): string[] {
  const gates = asRecord(document).gates;
  if (!Array.isArray(gates)) return [];
  const rows = gates.map((gate) => asRecord(gate));
  const verify = rows.find((gate) => str(gate.id) === "verify");
  const required = rows.find((gate) => gate.required === true);
  const chosen = verify ?? required ?? rows[0];
  if (!chosen || !Array.isArray(chosen.argv)) return [];
  return chosen.argv.map((part) => str(part)).filter((part) => part.length > 0);
}

