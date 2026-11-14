import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  DECISIONS,
  GOVERNANCE_MODES,
  answerQuestion,
  appealFinding,
  getGate,
  invalidateProject,
  probeVerification,
  getOrder,
  getProject,
  grantScope,
  queryKeys,
  resolveCase,
  setGovernance,
  type Decision,
  type GateCase,
  type GateFinding,
  type GateHold,
  type GateQuestion,
  type GovernanceMode,
} from "../api";
import { useOwnerSubmit } from "../ownerAction";
import { cap, linesToList } from "../text";
import {
  ErrorNote,
  Loading,
  Notice,
  OwnerKeyField,
  PageHeading,
  SelectField,
  StatusTag,
  TextAreaField,
  TextField,
  VerificationCommandField,
} from "../ui";

export function GatePage() {
  const { projectId = "" } = useParams();
  const gate = useQuery({ queryKey: queryKeys.gate(projectId), queryFn: () => getGate(projectId) });
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => getProject(projectId),
  });
  const order = useQuery({
    queryKey: queryKeys.order(projectId),
    queryFn: () => getOrder(projectId),
  });
  const failing = gate.data?.holds.filter((hold) => hold.failing) ?? [];
  const resting = gate.data?.holds.filter((hold) => !hold.failing) ?? [];
  const questions = gate.data?.questions ?? [];
  const cases = gate.data?.cases ?? [];
  const findings = gate.data?.findings ?? [];
  const waiting =
    failing.length + resting.length + questions.length + cases.length + findings.length > 0;

  return (
    <div className="stack">
      <PageHeading
        kicker="Gate"
        title="Gate"
        lead="Failing holds, open questions, and governance cases."
      />
      {gate.isPending ? <Loading>Loading the gate…</Loading> : null}
      {gate.isError ? <ErrorNote error={gate.error} /> : null}
      {gate.data && !waiting ? <p>Nothing is waiting at the gate.</p> : null}
      {failing.length > 0 ? (
        <section className="card stack">
          <h2>Failing holds</h2>
          <ul className="plain-list">
            {failing.map((hold) => (
              <HoldCard key={hold.id} projectId={projectId} hold={hold} />
            ))}
          </ul>
        </section>
      ) : null}
      {resting.length > 0 ? (
        <section className="card stack">
          <h2>Other holds</h2>
          <ul className="plain-list">
            {resting.map((hold) => (
              <HoldCard key={hold.id} projectId={projectId} hold={hold} />
            ))}
          </ul>
        </section>
      ) : null}
      {questions.length > 0 ? (
        <section className="card stack">
          <h2>Questions</h2>
          {questions.map((question, index) => (
            <QuestionCard
              key={question.id}
              projectId={projectId}
              question={question}
              primary={index === 0}
            />
          ))}
        </section>
      ) : null}
      {cases.length > 0 ? (
        <section className="card stack">
          <h2>Governance cases</h2>
          {cases.map((gateCase) => (
            <CaseCard key={gateCase.id} projectId={projectId} gateCase={gateCase} />
          ))}
        </section>
      ) : null}
      {findings.length > 0 ? (
        <section className="card stack">
          <h2>Findings</h2>
          {findings.map((finding) => (
            <FindingCard key={finding.id} projectId={projectId} finding={finding} />
          ))}
        </section>
      ) : null}
      <details>
        <summary>More gate tools</summary>
        <div className="stack">
          <GovernanceForm projectId={projectId} mode={project.data?.project.governanceMode ?? ""} />
          <ScopeForm projectId={projectId} items={order.data?.items ?? []} orderError={order.error} />
        </div>
      </details>
    </div>
  );
}

function HoldCard({ projectId, hold }: { projectId: string; hold: GateHold }) {
  return (
    <li className="list-card stack">
      <h3>{hold.title}</h3>
      <p>
        Status: <StatusTag status={hold.status} />
      </p>
      <p>{hold.reason || "Reason: none recorded."}</p>
      {hold.workItemId ? (
        <Link to={`/p/${projectId}/order/${hold.workItemId}`}>Open work room</Link>
      ) : null}
    </li>
  );
}

function QuestionCard({
  projectId,
  question,
  primary,
}: {
  projectId: string;
  question: GateQuestion;
  primary: boolean;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const discovery = question.role === "discovery";
  const answer = useMutation({
    mutationFn: () => answerQuestion(projectId, question.runId, text.trim()),
    onSuccess: async () => {
      setText("");
      setNotice("Answer sent.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.gate(projectId) });
    },
  });
  const probe = useMutation({
    mutationFn: () => probeVerification(projectId, text.trim()),
    onSuccess: async (ack) => {
      setNotice(
        ack.outcome === "rejected"
          ? "The probe did not pass, so no runbook is active."
          : ack.outcome === "active"
            ? "Verification is active."
            : "Verification submitted."
      );
      if (ack.outcome === "active") setText("");
      await invalidateProject(projectId);
    },
  });
  const mutation = discovery ? probe : answer;

  return (
    <form
      className="list-card stack"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (discovery) {
          if (!text.trim()) return;
        } else if (!question.runId || !text.trim()) {
          return;
        }
        setNotice(null);
        mutation.mutate();
      }}
    >
      <h3>{question.prompt}</h3>
      <p>
        Status: <StatusTag status={question.status} />
      </p>
      {discovery ? (
        <>
          <VerificationCommandField
            id={`verify-${question.id}`}
            value={text}
            onChange={setText}
          />
          {notice === "The probe did not pass, so no runbook is active." && text.trim() ? (
            <p className="mono">{text.trim()}</p>
          ) : null}
          <ErrorNote error={mutation.error} />
          <Notice>{notice}</Notice>
          <button type="submit" className={primary ? undefined : "quiet"} disabled={mutation.isPending || !text.trim()}>
            {mutation.isPending ? "Probing…" : "Probe verification"}
          </button>
        </>
      ) : question.runId ? (
        <>
          <p className="mono">Run id: {question.runId}</p>
          <TextAreaField
            id={`answer-${question.id}`}
            label="Answer"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <ErrorNote error={mutation.error} />
          <Notice>{notice}</Notice>
          <button type="submit" className={primary ? undefined : "quiet"} disabled={mutation.isPending || !text.trim()}>
            {mutation.isPending ? "Sending answer…" : "Send answer"}
          </button>
        </>
      ) : (
        <p>This question has no run id, so it cannot be answered from here.</p>
      )}
    </form>
  );
}

function CaseCard({ projectId, gateCase }: { projectId: string; gateCase: GateCase }) {
  const owner = useOwnerSubmit([queryKeys.gate(projectId), queryKeys.project(projectId)]);
  const [decision, setDecision] = useState<Decision | "">("");
  const [rationale, setRationale] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!decision) {
      setLocalError("Choose reject or allow once.");
      return;
    }
    if (!rationale.trim()) {
      setLocalError("Enter a rationale.");
      return;
    }
    setLocalError(null);
    const chosen = decision;
    const text = rationale.trim();
    setRationale("");
    void owner.submit(
      owner.ownerKey,
      (ownerKey) =>
        resolveCase(projectId, gateCase.id, { ownerKey, decision: chosen, rationale: text }),
      "Case resolved."
    );
  }

  return (
    <form className="list-card stack" onSubmit={onSubmit}>
      <h3>{gateCase.title}</h3>
      <p>
        Status: <StatusTag status={gateCase.status} />
      </p>
      <p>{gateCase.summary || "Summary: none recorded."}</p>
      {gateCase.workItemId ? (
        <Link to={`/p/${projectId}/order/${gateCase.workItemId}`}>Open work room</Link>
      ) : null}
      <SelectField
        id={`decision-${gateCase.id}`}
        label="Decision"
        value={decision}
        onChange={(event) => setDecision(event.target.value as Decision | "")}
      >
        <option value="">Choose a decision</option>
        {DECISIONS.map((item) => (
          <option key={item} value={item}>
            {item === "allow_once" ? "Allow once" : "Reject"}
          </option>
        ))}
      </SelectField>
      <TextAreaField
        id={`rationale-${gateCase.id}`}
        label="Rationale"
        value={rationale}
        onChange={(event) => setRationale(event.target.value)}
      />
      <OwnerKeyField value={owner.ownerKey} onChange={owner.setOwnerKey} disabled={owner.pending} />
      <ErrorNote error={localError ? new Error(localError) : owner.error} />
      <Notice>{owner.notice}</Notice>
      <button type="submit" className="quiet" disabled={owner.pending}>
        {owner.pending ? "Resolving…" : "Resolve case"}
      </button>
    </form>
  );
}

function FindingCard({ projectId, finding }: { projectId: string; finding: GateFinding }) {
  const queryClient = useQueryClient();
  const [alternatives, setAlternatives] = useState("");
  const [evidence, setEvidence] = useState("");
  const [risks, setRisks] = useState("");
  const [limits, setLimits] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      appealFinding(projectId, finding.id, {
        alternatives: alternatives.trim(),
        evidence: evidence.trim(),
        risks: risks.trim(),
        limits: limits.trim(),
      }),
    onSuccess: async () => {
      setAlternatives("");
      setEvidence("");
      setRisks("");
      setLimits("");
      setNotice("Appeal submitted.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.gate(projectId) });
    },
  });

  return (
    <form
      className="list-card stack"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!alternatives.trim() || !evidence.trim() || !risks.trim() || !limits.trim()) {
          setLocalError("Fill in alternatives, evidence, risks, and limits.");
          return;
        }
        setLocalError(null);
        setNotice(null);
        mutation.mutate();
      }}
    >
      <h3>{finding.title}</h3>
      <p>
        Status: <StatusTag status={finding.status} />
      </p>
      <p>{finding.summary || "Summary: none recorded."}</p>
      <p>Rule: {finding.rule ?? "none recorded"}</p>
      <TextAreaField
        id={`alt-${finding.id}`}
        label="Alternatives"
        value={alternatives}
        onChange={(event) => setAlternatives(event.target.value)}
      />
      <TextAreaField
        id={`evi-${finding.id}`}
        label="Evidence"
        value={evidence}
        onChange={(event) => setEvidence(event.target.value)}
      />
      <TextAreaField
        id={`risk-${finding.id}`}
        label="Risks"
        value={risks}
        onChange={(event) => setRisks(event.target.value)}
      />
      <TextAreaField
        id={`lim-${finding.id}`}
        label="Limits"
        value={limits}
        onChange={(event) => setLimits(event.target.value)}
      />
      <ErrorNote error={localError ? new Error(localError) : mutation.error} />
      <Notice>{notice}</Notice>
      <button type="submit" className="quiet" disabled={mutation.isPending}>
        {mutation.isPending ? "Submitting appeal…" : "Submit appeal"}
      </button>
    </form>
  );
}

function GovernanceForm({ projectId, mode }: { projectId: string; mode: string }) {
  const owner = useOwnerSubmit([
    queryKeys.project(projectId),
    queryKeys.gate(projectId),
    queryKeys.home,
  ]);
  const valid = (GOVERNANCE_MODES as readonly string[]).includes(mode);
  const [picked, setPicked] = useState<GovernanceMode | "">("");
  const [localError, setLocalError] = useState<string | null>(null);
  const selected = picked || (valid ? (mode as GovernanceMode) : "");

  return (
    <form
      className="card stack"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!selected) {
          setLocalError("Choose a governance mode.");
          return;
        }
        setLocalError(null);
        const next = selected;
        void owner.submit(
          owner.ownerKey,
          (ownerKey) => setGovernance(projectId, { ownerKey, mode: next }),
          "Governance mode saved."
        );
      }}
    >
      <h2>Governance mode</h2>
      <p>
        Current mode: <StatusTag status={mode || "unknown"} />
      </p>
      <SelectField
        id={`mode-${projectId}`}
        label="Mode"
        value={selected}
        onChange={(event) => setPicked(event.target.value as GovernanceMode)}
      >
        <option value="">Choose a mode</option>
        {GOVERNANCE_MODES.map((item) => (
          <option key={item} value={item}>
            {cap(item)}
          </option>
        ))}
      </SelectField>
      <OwnerKeyField value={owner.ownerKey} onChange={owner.setOwnerKey} disabled={owner.pending} />
      <ErrorNote error={localError ? new Error(localError) : owner.error} />
      <Notice>{owner.notice}</Notice>
      <button type="submit" className="quiet" disabled={owner.pending}>
        {owner.pending ? "Saving mode…" : "Save governance mode"}
      </button>
    </form>
  );
}

function ScopeForm({
  projectId,
  items,
  orderError,
}: {
  projectId: string;
  items: Array<{ id: string; title: string }>;
  orderError: unknown;
}) {
  const owner = useOwnerSubmit([queryKeys.gate(projectId), queryKeys.order(projectId)]);
  const [workItemId, setWorkItemId] = useState("");
  const [pathsText, setPathsText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <form
      className="card stack"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const paths = linesToList(pathsText);
        if (!workItemId.trim()) {
          setLocalError("Enter a work item id.");
          return;
        }
        if (paths.length === 0) {
          setLocalError("Enter at least one scope path.");
          return;
        }
        setLocalError(null);
        const id = workItemId.trim();
        setPathsText("");
        void owner.submit(
          owner.ownerKey,
          (ownerKey) => grantScope(projectId, { ownerKey, workItemId: id, paths }),
          "Scope grant submitted."
        );
      }}
    >
      <h2>Grant protected-path scope</h2>
      <ErrorNote error={orderError} />
      {items.length > 0 ? (
        <SelectField
          id={`scope-item-${projectId}`}
          label="Work item"
          hint="Choosing a work item fills the id."
          value={items.some((item) => item.id === workItemId) ? workItemId : ""}
          onChange={(event) => setWorkItemId(event.target.value)}
        >
          <option value="">Choose a work item</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </SelectField>
      ) : null}
      <TextField
        id={`scope-id-${projectId}`}
        label="Work item id"
        spellCheck={false}
        value={workItemId}
        onChange={(event) => setWorkItemId(event.target.value)}
      />
      <TextAreaField
        id={`scope-paths-${projectId}`}
        label="Paths"
        hint="One path per line."
        spellCheck={false}
        value={pathsText}
        onChange={(event) => setPathsText(event.target.value)}
      />
      <OwnerKeyField value={owner.ownerKey} onChange={owner.setOwnerKey} disabled={owner.pending} />
      <ErrorNote error={localError ? new Error(localError) : owner.error} />
      <Notice>{owner.notice}</Notice>
      <button type="submit" className="quiet" disabled={owner.pending}>
        {owner.pending ? "Granting scope…" : "Grant scope"}
      </button>
    </form>
  );
}
