import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  claimControl,
  getMembers,
  getProject,
  getWorkRoom,
  handoffControl,
  postThread,
  queryKeys,
  submitGuidance,
} from "../api";
import { diffGitPath, formatWhen, isBlankFact, newIdempotencyKey } from "../text";
import {
  DiffView,
  Empty,
  ErrorNote,
  Loading,
  MetaList,
  Notice,
  PageHeading,
  SelectField,
  StatusTag,
  TextAreaField,
} from "../ui";
import { useVocabulary } from "../vocabulary";

const THREAD_GUIDE_COPY = "A thread post stays on the thread. Only Guide submits guidance.";
const NEXT_ATTEMPT_COPY = "This runtime applies guidance on the next attempt.";

export function WorkRoomPage() {
  const { projectId = "", workItemId = "" } = useParams();
  const { names } = useVocabulary();
  const queryClient = useQueryClient();
  const base = useId();
  const room = useQuery({
    queryKey: queryKeys.workItem(projectId, workItemId),
    queryFn: () => getWorkRoom(projectId, workItemId),
  });
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => getProject(projectId),
  });
  const teamId = project.data?.project.teamId ?? "";
  const members = useQuery({
    queryKey: queryKeys.members(teamId),
    queryFn: () => getMembers(teamId),
    enabled: Boolean(teamId),
  });

  const [postBody, setPostBody] = useState("");
  const [guideBody, setGuideBody] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [toUserId, setToUserId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setPostBody("");
    setGuideBody("");
    setToUserId("");
    setNotice(null);
    setIdempotencyKey(newIdempotencyKey());
  }, [projectId, workItemId]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.workItem(projectId, workItemId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.order(projectId) });
  }

  const post = useMutation({
    mutationFn: () => postThread(projectId, workItemId, { body: postBody, idempotencyKey }),
    onSuccess: async () => {
      setPostBody("");
      setIdempotencyKey(newIdempotencyKey());
      setNotice("Posted to the thread.");
      await refresh();
    },
  });
  const guide = useMutation({
    mutationFn: (input: { revision: number; body: string }) =>
      submitGuidance(projectId, workItemId, input),
    onSuccess: async () => {
      setGuideBody("");
      setNotice("Guidance submitted.");
      await refresh();
    },
  });
  const claim = useMutation({
    mutationFn: (revision: number) => claimControl(projectId, workItemId, revision),
    onSuccess: async () => {
      setNotice("Control claimed.");
      await refresh();
    },
  });
  const handoff = useMutation({
    mutationFn: (input: { revision: number; toUserId: string }) =>
      handoffControl(projectId, workItemId, input),
    onSuccess: async () => {
      setToUserId("");
      setNotice("Control handed off.");
      await refresh();
    },
  });

  if (room.isPending) return <Loading>Loading work room…</Loading>;
  if (room.isError || !room.data)
    return <ErrorNote error={room.error ?? new Error("The work room did not load.")} />;

  const detail = room.data;
  const item = detail.item;
  const revisionToSend = detail.controller?.revision ?? detail.run?.controlRevision ?? 0;
  const owner = members.data?.find((member) => member.userId === item.ownerUserId);
  const ownerLabel = owner ? `${owner.name} (${owner.email})` : item.ownerUserId;
  const teammates = members.data ?? [];
  const kindLabel = (kind: string) =>
    kind === "post" ? "Post" : kind === "guidance" ? "Guidance" : kind;
  const runState = detail.run?.state ?? "";
  const heldShip = item.status === "held" && !item.shipCommit;
  const doneShip = item.status === "done";
  const guideVisible = Boolean(detail.run && runState !== "held" && runState !== "done");
  const postQuiet = guideVisible || heldShip || doneShip || runState === "held" || runState === "done";
  const controlsVisible = Boolean(detail.run && runState !== "done");
  const patch = patchText(detail.diff);
  const opening = doneShip ? shippedOpening(detail.run?.resultSummary, detail.diff) : "";
  const moreDetail = doneShip
    ? [
        ...(!isBlankFact(item.shipCommit)
          ? [{ term: "Ship commit", value: <span className="mono">{item.shipCommit}</span> }]
          : []),
        ...(detail.run && !isBlankFact(detail.run.id)
          ? [{ term: "Run id", value: <span className="mono">{detail.run.id}</span> }]
          : []),
        ...(detail.run && !isBlankFact(detail.run.runbookDigest)
          ? [
              {
                term: "Runbook digest",
                value: <span className="mono">{detail.run.runbookDigest}</span>,
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="stack">
      <PageHeading
        kicker="Work room"
        title={item.title}
        lead={`Opened from the order queue. This is where the ${names.agent} run is reviewed.`}
      />
      <p>
        <Link to={`/p/${projectId}/order`}>Back to order</Link>
      </p>
      <Notice>{notice}</Notice>
      <section className="card stack">
        {doneShip || heldShip ? null : <h2>Status</h2>}
        {doneShip ? <p>{opening}</p> : null}
        {heldShip ? <p>The ship is held. Nothing was pushed.</p> : null}
        {(heldShip || doneShip) && patch.trim() ? <DiffView diff={patch} /> : null}
        {moreDetail.length > 0 ? (
          <details>
            <summary>More detail</summary>
            <MetaList items={moreDetail} />
          </details>
        ) : null}
        {doneShip || heldShip ? null : (
          <p>
            <StatusTag status={item.status} />
          </p>
        )}
        {isBlankFact(ownerLabel) &&
        isBlankFact(item.blockedReason) &&
        (doneShip || isBlankFact(item.shipCommit)) &&
        isBlankFact(item.parentId) ? null : (
          <MetaList
            items={[
              ...(!isBlankFact(ownerLabel) ? [{ term: "Owner", value: ownerLabel }] : []),
              ...(!isBlankFact(item.blockedReason)
                ? [{ term: "Blocked", value: item.blockedReason }]
                : []),
              ...(!doneShip && !isBlankFact(item.shipCommit)
                ? [{ term: "Ship commit", value: <span className="mono">{item.shipCommit}</span> }]
                : []),
              ...(item.parentId && !isBlankFact(item.parentId)
                ? [
                    {
                      term: "Parent",
                      value: (
                        <Link to={`/p/${projectId}/order/${item.parentId}`}>{item.parentId}</Link>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {item.body.trim() ? (
          <>
            <h3>Body</h3>
            <pre className="exact">{item.body}</pre>
          </>
        ) : null}
        {item.scopePaths.length > 0 ? (
          <>
            <h3>Scope paths</h3>
            <ul>
              {item.scopePaths.map((scopePath) => (
                <li key={scopePath}>
                  <code>{scopePath}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {detail.dependencies.length > 0 ? (
          <>
            <h3>Dependencies</h3>
            <ul>
              {detail.dependencies.map((row) => (
                <li key={`${row.workItemId}-${row.dependsOnId}`}>
                  <Link to={`/p/${projectId}/order/${row.workItemId}`}>{row.workItemId}</Link>
                  {" depends on "}
                  <Link to={`/p/${projectId}/order/${row.dependsOnId}`}>{row.dependsOnId}</Link>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      {!heldShip && !doneShip && detail.diff.trim() ? (
        <section className="card stack">
          <h2>Unified diff</h2>
          <DiffView diff={detail.diff} />
        </section>
      ) : null}

      {detail.evidence.length > 0 ? (
        <section className="card stack">
          <h2>Gate evidence</h2>
          <ul className="plain-list">
            {detail.evidence.map((row, index) => (
              <li key={`${index}-${row.command}`} className="list-card stack">
                <p className="mono">{row.command || "Command not reported."}</p>
                <p>
                  {row.exitCode == null
                    ? "Exit code was not reported."
                    : row.exitCode === 0
                      ? `Passed, exit code ${row.exitCode}.`
                      : `Failed, exit code ${row.exitCode}.`}
                </p>
                {row.excerpt ? <pre className="exact">{row.excerpt}</pre> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card stack">
        <h2>Thread</h2>
        {detail.thread.entries.length === 0 ? (
          <Empty>The thread is empty. Post when you want a note to stay on the thread.</Empty>
        ) : (
          <ol className="plain-list">
            {detail.thread.entries.map((entry) => (
              <li
                key={entry.id}
                className={entry.kind === "guidance" ? "thread-entry guidance" : "thread-entry"}
              >
                <p>
                  <StatusTag status={kindLabel(entry.kind)} /> {entry.authorName}
                  {entry.authorId ? ` (${entry.authorId})` : ""}
                </p>
                <p>{formatWhen(entry.createdAt)}</p>
                <pre className="exact">{entry.body}</pre>
              </li>
            ))}
          </ol>
        )}
        <form
          className="stack"
          aria-describedby={guideVisible ? `${base}-copy` : undefined}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (!postBody.trim()) return;
            post.mutate();
          }}
        >
          <TextAreaField
            id={`${base}-post`}
            label="Thread post"
            value={postBody}
            onChange={(event) => setPostBody(event.target.value)}
          />
          <ErrorNote error={post.error} />
          <button
            type="submit"
            className={postQuiet ? "quiet" : undefined}
            disabled={post.isPending || !postBody.trim()}
          >
            {post.isPending ? "Posting…" : "Post to the thread"}
          </button>
        </form>
      </section>

      {guideVisible ? (
      <section className="card guide-panel stack" aria-labelledby={`${base}-guide-heading`}>
        <h2 id={`${base}-guide-heading`}>Guide the {names.agent}</h2>
        <p id={`${base}-copy`}>{THREAD_GUIDE_COPY}</p>
        {detail.run?.midTurn === "next_attempt" ? <p>{NEXT_ATTEMPT_COPY}</p> : null}
        {detail.run?.midTurn && detail.run.midTurn !== "next_attempt" ? (
          <p>Mid-turn: {detail.run.midTurn}.</p>
        ) : null}
        <form
          className="stack"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (!guideBody.trim()) return;
            guide.mutate({ revision: revisionToSend, body: guideBody });
          }}
        >
          <TextAreaField
            id={`${base}-guide`}
            label="Guidance"
            value={guideBody}
            onChange={(event) => setGuideBody(event.target.value)}
          />
          <ErrorNote error={guide.error} />
          <button type="submit" disabled={guide.isPending || !guideBody.trim()}>
            {guide.isPending ? "Sending guidance…" : "Guide"}
          </button>
        </form>
      </section>
      ) : null}

      {controlsVisible ? (
      <section className="card stack">
        <h2>Controller</h2>
        {detail.controller ? <p>Controller: {detail.controller.name}</p> : null}
        <ErrorNote error={claim.error} />
        <button
          type="button"
          className="quiet"
          disabled={claim.isPending}
          onClick={() => claim.mutate(revisionToSend)}
        >
          {claim.isPending ? "Claiming…" : "Claim control"}
        </button>
        <ErrorNote error={members.error} />
        {members.isSuccess && teammates.length === 0 ? (
          <p>Invite a teammate before handing off.</p>
        ) : null}
        {teammates.length > 0 ? (
          <form
            className="stack"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (!toUserId.trim()) return;
              handoff.mutate({ revision: revisionToSend, toUserId: toUserId.trim() });
            }}
          >
            <SelectField
              id={`${base}-member`}
              label="Team member"
              value={teammates.some((member) => member.userId === toUserId) ? toUserId : ""}
              onChange={(event) => setToUserId(event.target.value)}
            >
              <option value="">Choose a person</option>
              {teammates.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name} ({member.email})
                </option>
              ))}
            </SelectField>
            <ErrorNote error={handoff.error} />
            <button type="submit" className="quiet" disabled={handoff.isPending || !toUserId.trim()}>
              {handoff.isPending ? "Handing off…" : "Hand off"}
            </button>
          </form>
        ) : null}
      </section>
      ) : null}

      {detail.run ? (
        <section className="card stack">
          <h2>Run</h2>
          <MetaList
            items={[
              { term: "State", value: <StatusTag status={detail.run.state} /> },
              { term: "Attempt", value: String(detail.run.attempt) },
              ...(showResult(runState, detail.run.resultStatus)
                ? [{ term: "Result", value: detail.run.resultStatus }]
                : []),
              ...(!doneShip && !isBlankFact(detail.run.resultSummary)
                ? [{ term: "Summary", value: detail.run.resultSummary }]
                : []),
              ...(!isBlankFact(detail.run.policyRule)
                ? [{ term: "Policy rule", value: detail.run.policyRule }]
                : []),
              ...(!isBlankFact(detail.run.policyPin)
                ? [{ term: "Policy pin", value: detail.run.policyPin }]
                : []),
              ...(detail.run.frameVersion == null
                ? []
                : [{ term: "Frame version", value: String(detail.run.frameVersion) }]),
              ...(!doneShip && !isBlankFact(detail.run.runbookDigest)
                ? [
                    {
                      term: "Runbook digest",
                      value: <span className="mono">{detail.run.runbookDigest}</span>,
                    },
                  ]
                : []),
              ...(!doneShip && !isBlankFact(detail.run.id)
                ? [{ term: "Run id", value: <span className="mono">{detail.run.id}</span> }]
                : []),
            ]}
          />
          {detail.run.questions.length > 0 ? (
            <>
              <h3>Run questions</h3>
              <ul>
                {detail.run.questions.map((question, index) => (
                  <li key={`${index}-${question}`}>{question}</li>
                ))}
              </ul>
              <Link to={`/p/${projectId}/gate`}>Answer questions on the Gate page</Link>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function showResult(state: string, status: string | null): boolean {
  if (status == null || isBlankFact(status)) return false;
  const text = status.trim().toLowerCase().replace(/[.!]$/, "");
  return !(state === "held" && text === "succeeded");
}

function patchText(diff: string): string {
  const marker = diff.search(/^diff --git /m);
  if (marker <= 0) return diff;
  const head = diff.slice(0, marker);
  if (/(^|\n)(commit [0-9a-f]{7,}|Author:|Date:)/.test(head)) return diff.slice(marker);
  return diff;
}

const VACANT_SUMMARY = new Set(["done", "shipped", "succeeded", "ok", "passed"]);

function filesInDiff(diff: string): string[] {
  const names: string[] = [];
  for (const line of diff.split("\n")) {
    const name = diffGitPath(line);
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

function filesSentence(files: string[]): string {
  if (files.length === 1) return `The change is in ${files[0]}.`;
  const last = files[files.length - 1] ?? "";
  if (files.length === 2) return `The change is in ${files[0]} and ${last}.`;
  return `The change is in ${files.slice(0, -1).join(", ")}, and ${last}.`;
}

function shippedOpening(summary: string | null | undefined, diff: string): string {
  const text = summary?.trim() ?? "";
  const bare = text.replace(/[.!?]+$/, "").trim().toLowerCase();
  if (!text || VACANT_SUMMARY.has(bare)) {
    const files = filesInDiff(diff);
    if (files.length === 0) return "Shipped.";
    return `Shipped. ${filesSentence(files)}`;
  }
  return /[.!?]$/.test(text) ? `Shipped. ${text}` : `Shipped. ${text}.`;
}
