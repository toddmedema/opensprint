import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { type Ack, errorMessage } from "./api";
import { cx, diffGitPath, toneForStatus } from "./text";

export function PageHeading({
  kicker,
  title,
  lead,
}: {
  kicker?: string;
  title: string;
  lead?: string;
}) {
  return (
    <header className="page-heading">
      {kicker ? <p className="kicker">{kicker}</p> : null}
      <h1>{title}</h1>
      {lead ? <p className="lead">{lead}</p> : null}
    </header>
  );
}

export function Loading({ children }: { children: string }) {
  return <p role="status">{children}</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      Error: {errorMessage(error)}
    </p>
  );
}

export function Notice({ children }: { children: string | null | undefined }) {
  if (!children) return null;
  return (
    <p className="note" role="status">
      {children}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Retry({ onRetry, pending }: { onRetry: () => void; pending?: boolean }) {
  return (
    <button type="button" className="secondary" onClick={onRetry} disabled={pending}>
      {pending ? "Trying again…" : "Try again"}
    </button>
  );
}

export function StatusTag({ status }: { status: string }) {
  return <strong className={cx("tag", toneForStatus(status))}>{status}</strong>;
}

export function AckNote({ ack }: { ack: Ack | null }) {
  if (!ack) return null;
  const failed =
    Boolean(ack.failure) || (ack.outcome != null && /fail|error|reject/i.test(ack.outcome));
  const hasDetail = Boolean(
    ack.outcome || ack.detail || ack.failure || ack.digest || ack.questions.length > 0
  );
  return (
    <div className={failed ? "error" : "note"} role={failed ? "alert" : "status"}>
      {ack.outcome ? <p>Outcome: {ack.outcome}</p> : null}
      {ack.detail ? <p>{ack.detail}</p> : null}
      {ack.failure ? <p>Failure: {ack.failure}</p> : null}
      {ack.digest ? <p className="mono">Digest {ack.digest}</p> : null}
      {ack.questions.length > 0 ? (
        <>
          <p>Questions</p>
          <ul>
            {ack.questions.map((question, index) => (
              <li key={`${index}-${question}`}>{question}</li>
            ))}
          </ul>
        </>
      ) : null}
      {hasDetail ? null : <p>The server accepted the request.</p>}
    </div>
  );
}

function Hint({ id, hint }: { id: string; hint?: string }) {
  if (!hint) return null;
  return (
    <p className="hint" id={`${id}-hint`}>
      {hint}
    </p>
  );
}

export function VerificationCommandField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Verification command</label>
      <input
        id={id}
        placeholder="node verify.mjs"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <p className="hint" id={`${id}-hint`}>
        Program and arguments, separated by spaces. Forge runs this in the repository and keeps the
        runbook only if it exits 0.
      </p>
    </div>
  );
}

export function TextField({
  id,
  label,
  hint,
  ...props
}: {
  id: string;
  label: string;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...props} />
      <Hint id={id} hint={hint} />
    </div>
  );
}

export function TextAreaField({
  id,
  label,
  hint,
  ...props
}: {
  id: string;
  label: string;
  hint?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...props} />
      <Hint id={id} hint={hint} />
    </div>
  );
}

export function SelectField({
  id,
  label,
  hint,
  children,
  ...props
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...props}>
        {children}
      </select>
      <Hint id={id} hint={hint} />
    </div>
  );
}

export function OwnerKeyField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <TextField
      id={id}
      label="Owner key"
      hint="Used for this submit only. It stays in component state and is cleared after submit."
      type="password"
      name="forge-owner-key"
      autoComplete="off"
      spellCheck={false}
      data-1p-ignore="true"
      data-lpignore="true"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function MetaList({ items }: { items: Array<{ term: string; value: ReactNode }> }) {
  return (
    <dl className="meta">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ExactText({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <h4>{label}</h4>
      {value ? (
        <pre className="exact">{value}</pre>
      ) : (
        <p className="empty">No {label.toLowerCase()} text.</p>
      )}
    </div>
  );
}

export function EvidenceLists({
  supporting,
  contrary,
}: {
  supporting: string[];
  contrary: string[];
}) {
  return (
    <div className="split">
      <div>
        <h4>Supporting evidence</h4>
        {supporting.length === 0 ? (
          <p className="empty">Supporting evidence: none recorded.</p>
        ) : (
          <ul>
            {supporting.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4>Contrary evidence</h4>
        {contrary.length === 0 ? (
          <p className="empty">Contrary evidence: none recorded.</p>
        ) : (
          <ul>
            {contrary.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function diffClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "diff-line add";
  if (line.startsWith("-") && !line.startsWith("---")) return "diff-line del";
  if (line.startsWith("@@")) return "diff-line hunk";
  return "diff-line";
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="empty">The work room has no diff yet.</p>;
  const files = splitDiff(diff);
  return (
    <div className="diff" role="region" aria-label="Unified diff">
      {files.map((file, fileIndex) => (
        <div className="diff-file" key={`${fileIndex}-${file.path ?? "text"}`}>
          {file.path ? <h3 className="diff-path">{file.path}</h3> : null}
          {file.lines.map((line, index) => (
            <div key={`${fileIndex}-${index}`} className={diffClass(line)}>
              {line || " "}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function splitDiff(diff: string): Array<{ path: string | null; lines: string[] }> {
  const files: Array<{ path: string | null; lines: string[] }> = [];
  for (const piece of diff.split(/^(?=diff --git )/m)) {
    if (piece.length === 0) continue;
    const lines = piece.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) continue;
    const header = lines[0] ?? "";
    if (!header.startsWith("diff --git ")) {
      files.push({ path: null, lines });
      continue;
    }
    files.push({ path: diffGitPath(header), lines: diffBody(lines.slice(1)) });
  }
  return files;
}

function diffBody(lines: string[]): string[] {
  const body: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) inHunk = true;
    if (!inHunk && isDiffMeta(line)) continue;
    body.push(line);
  }
  return body;
}

function isDiffMeta(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  );
}
