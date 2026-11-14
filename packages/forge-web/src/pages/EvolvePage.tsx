import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import {
  AUTHOR_KINDS,
  DETECTOR,
  FALLBACK_REPLAY_NOTE,
  activateProposal,
  evaluateProposal,
  getEvolve,
  mineDecisions,
  proposeNomination,
  queryKeys,
  rollbackRelease,
  type Ack,
  type AuthorKind,
  type Evaluation,
  type Nomination,
  type Proposal,
  type Release,
} from "../api";
import { useOwnerSubmit } from "../ownerAction";
import { formatWhen, linesToList } from "../text";
import {
  AckNote,
  Empty,
  ErrorNote,
  EvidenceLists,
  ExactText,
  Loading,
  Notice,
  OwnerKeyField,
  PageHeading,
  SelectField,
  StatusTag,
  TextAreaField,
  TextField,
} from "../ui";

export function EvolvePage() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const evolve = useQuery({
    queryKey: queryKeys.evolve(projectId),
    queryFn: () => getEvolve(projectId),
  });
  const [mineAck, setMineAck] = useState<Ack | null>(null);
  const mine = useMutation({
    mutationFn: () => mineDecisions(projectId),
    onSuccess: async (ack) => {
      setMineAck(ack);
      await queryClient.invalidateQueries({ queryKey: queryKeys.evolve(projectId) });
    },
  });

  const idle = Boolean(
    evolve.data &&
      evolve.data.nominations.length === 0 &&
      evolve.data.proposals.length === 0 &&
      evolve.data.evaluations.length === 0 &&
      evolve.data.releases.length === 0
  );
  const primaryId = !evolve.data
    ? ""
    : idle
      ? "mine"
      : evolve.data.nominations[0]
        ? `propose:${evolve.data.nominations[0].id}`
        : evolve.data.proposals[0]
          ? `evaluate:${evolve.data.proposals[0].id}`
          : evolve.data.releases[0]
            ? `rollback:${evolve.data.releases[0].id}`
            : "mine";

  return (
    <div className="stack">
      <PageHeading
        kicker="Evolve"
        title="Evolve"
        lead="Nominations, exact text, evidence, and the release you can activate."
      />
      {evolve.isPending ? <Loading>Loading evolve…</Loading> : null}
      {evolve.isError ? <ErrorNote error={evolve.error} /> : null}
      {evolve.data ? <p className="note">{evolve.data.replayNote || FALLBACK_REPLAY_NOTE}</p> : null}
      {idle ? (
        <div className="stack">
          <p>No rule changes yet.</p>
          <button type="button" disabled={mine.isPending} onClick={() => mine.mutate()}>
            {mine.isPending ? "Mining…" : "Mine decisions"}
          </button>
          <ErrorNote error={mine.error} />
          <AckNote ack={mineAck} />
        </div>
      ) : evolve.data ? (
        <>
          <section className="card stack">
            <h2>Mine</h2>
            <p>Mine decisions into nominations.</p>
            <button
              type="button"
              className={primaryId === "mine" ? undefined : "quiet"}
              disabled={mine.isPending}
              onClick={() => mine.mutate()}
            >
              {mine.isPending ? "Mining…" : "Mine decisions"}
            </button>
            <ErrorNote error={mine.error} />
            <AckNote ack={mineAck} />
          </section>
          <section className="card stack">
            <h2>Nominations</h2>
            {evolve.data.nominations.length === 0 ? (
              <Empty>No nominations yet. Mine decisions to draft some.</Empty>
            ) : null}
            {evolve.data.nominations.map((nomination) => (
              <NominationCard
                key={nomination.id}
                projectId={projectId}
                nomination={nomination}
                primary={primaryId === `propose:${nomination.id}`}
              />
            ))}
          </section>
          <section className="card stack">
            <h2>Proposals</h2>
            {evolve.data.proposals.length === 0 ? <Empty>Proposals: none.</Empty> : null}
            {evolve.data.proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                projectId={projectId}
                proposal={proposal}
                primaryEvaluate={primaryId === `evaluate:${proposal.id}`}
              />
            ))}
          </section>
          <section className="card stack">
            <h2>Evaluations</h2>
            {evolve.data.evaluations.length === 0 ? <Empty>Evaluations: none.</Empty> : null}
            {evolve.data.evaluations.map((evaluation) => (
              <EvaluationCard key={evaluation.id} evaluation={evaluation} />
            ))}
          </section>
          <section className="card stack">
            <h2>Releases</h2>
            {evolve.data.releases.length === 0 ? <Empty>Releases: none.</Empty> : null}
            {evolve.data.releases.map((release) => (
              <ReleaseCard
                key={release.id}
                projectId={projectId}
                release={release}
                primary={primaryId === `rollback:${release.id}`}
              />
            ))}
          </section>
        </>
      ) : null}
    </div>
  );
}

function NominationCard({
  projectId,
  nomination,
  primary,
}: {
  projectId: string;
  nomination: Nomination;
  primary: boolean;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [authorKind, setAuthorKind] = useState<AuthorKind>("person");
  const [pathsText, setPathsText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      proposeNomination(projectId, nomination.id, {
        text: text.trim(),
        detector: DETECTOR,
        paths: linesToList(pathsText),
        authorKind,
      }),
    onSuccess: async () => {
      setText("");
      setPathsText("");
      setNotice("Proposal submitted.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.evolve(projectId) });
    },
  });

  return (
    <article className="list-card stack">
      <h3>{nomination.title}</h3>
      <p>
        Status: <StatusTag status={nomination.status} />
      </p>
      <div className="compare">
        <ExactText label="Before" value={nomination.beforeText} />
        <ExactText label="After" value={nomination.afterText} />
      </div>
      <EvidenceLists
        supporting={nomination.supportingEvidence}
        contrary={nomination.contraryEvidence}
      />
      <form
        className="stack"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (!text.trim()) {
            setLocalError("Enter the proposal text.");
            return;
          }
          setLocalError(null);
          setNotice(null);
          mutation.mutate();
        }}
      >
        <h4>Propose an amendment</h4>
        <TextAreaField
          id={`nom-text-${nomination.id}`}
          label="Proposal text"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <TextField
          id={`nom-detector-${nomination.id}`}
          label="Detector"
          value={DETECTOR}
          readOnly
        />
        <SelectField
          id={`nom-author-${nomination.id}`}
          label="Author kind"
          value={authorKind}
          onChange={(event) => setAuthorKind(event.target.value as AuthorKind)}
        >
          {AUTHOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind === "person" ? "Person" : "Drafter"}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          id={`nom-paths-${nomination.id}`}
          label="Paths"
          hint="One path per line."
          spellCheck={false}
          value={pathsText}
          onChange={(event) => setPathsText(event.target.value)}
        />
        <ErrorNote error={localError ? new Error(localError) : mutation.error} />
        <Notice>{notice}</Notice>
        <button type="submit" className={primary ? undefined : "quiet"} disabled={mutation.isPending}>
          {mutation.isPending ? "Submitting proposal…" : "Submit proposal"}
        </button>
      </form>
    </article>
  );
}

function ProposalCard({
  projectId,
  proposal,
  primaryEvaluate,
}: {
  projectId: string;
  proposal: Proposal;
  primaryEvaluate: boolean;
}) {
  const queryClient = useQueryClient();
  const owner = useOwnerSubmit([queryKeys.evolve(projectId)]);
  const [ack, setAck] = useState<Ack | null>(null);
  const evaluate = useMutation({
    mutationFn: () => evaluateProposal(projectId, proposal.id),
    onSuccess: async (result) => {
      setAck(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.evolve(projectId) });
    },
  });

  return (
    <article className="list-card stack">
      <h3>{proposal.text || proposal.id}</h3>
      <p>
        Evaluation: <StatusTag status={proposal.evaluationStatus} />
      </p>
      <p>
        Status: <StatusTag status={proposal.status} />
      </p>
      <p>Detector: {proposal.detector || "none recorded"}</p>
      <p>Author: {proposal.authorKind || "none recorded"}</p>
      {proposal.nominationId ? <p className="mono">Nomination {proposal.nominationId}</p> : null}
      {proposal.paths.length === 0 ? (
        <p>Paths: none recorded.</p>
      ) : (
        <ul>
          {proposal.paths.map((scopePath) => (
            <li key={scopePath}>
              <code>{scopePath}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="compare">
        <ExactText label="Before" value={proposal.beforeText} />
        <ExactText label="After" value={proposal.afterText} />
      </div>
      <EvidenceLists
        supporting={proposal.supportingEvidence}
        contrary={proposal.contraryEvidence}
      />
      <button
        type="button"
        className={primaryEvaluate ? undefined : "quiet"}
        disabled={evaluate.isPending}
        onClick={() => evaluate.mutate()}
      >
        {evaluate.isPending ? "Evaluating…" : "Evaluate"}
      </button>
      <ErrorNote error={evaluate.error} />
      <AckNote ack={ack} />
      <form
        className="stack"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void owner.submit(
            owner.ownerKey,
            (ownerKey) => activateProposal(projectId, proposal.id, ownerKey),
            "Activation requested."
          );
        }}
      >
        <OwnerKeyField
          value={owner.ownerKey}
          onChange={owner.setOwnerKey}
          disabled={owner.pending}
        />
        <ErrorNote error={owner.error} />
        <Notice>{owner.notice}</Notice>
        <button type="submit" className="quiet" disabled={owner.pending}>
          {owner.pending ? "Activating…" : "Activate"}
        </button>
      </form>
    </article>
  );
}

function EvaluationCard({ evaluation }: { evaluation: Evaluation }) {
  return (
    <article className="list-card stack">
      <h3>
        Evaluation <StatusTag status={evaluation.status} />
      </h3>
      {evaluation.proposalId ? <p className="mono">Proposal {evaluation.proposalId}</p> : null}
      <p>{evaluation.summary || "Summary: none recorded."}</p>
      <EvidenceLists
        supporting={evaluation.supportingEvidence}
        contrary={evaluation.contraryEvidence}
      />
    </article>
  );
}

function ReleaseCard({
  projectId,
  release,
  primary,
}: {
  projectId: string;
  release: Release;
  primary: boolean;
}) {
  const owner = useOwnerSubmit([queryKeys.evolve(projectId)]);

  return (
    <form
      className="list-card stack"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void owner.submit(
          owner.ownerKey,
          (ownerKey) => rollbackRelease(projectId, { ownerKey, releaseId: release.id }),
          "Rollback requested."
        );
      }}
    >
      <h3>{release.title}</h3>
      <p>
        Status: <StatusTag status={release.status} />
      </p>
      <p className="mono">Release id {release.id}</p>
      <p>{formatWhen(release.createdAt)}</p>
      <OwnerKeyField value={owner.ownerKey} onChange={owner.setOwnerKey} disabled={owner.pending} />
      <ErrorNote error={owner.error} />
      <Notice>{owner.notice}</Notice>
      <button type="submit" className={primary ? undefined : "quiet"} disabled={owner.pending}>
        {owner.pending ? "Rolling back…" : "Roll back to this release"}
      </button>
    </form>
  );
}
