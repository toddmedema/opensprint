import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  createWorkItem,
  getMembers,
  getOrder,
  getProject,
  planWork,
  queryKeys,
  type Ack,
} from "../api";
import { cap, isBlankFact, linesToList, plural } from "../text";
import { AckNote, Empty, ErrorNote, Loading, Notice, PageHeading, StatusTag } from "../ui";
import { useVocabulary } from "../vocabulary";

export function OrderPage() {
  const { projectId = "" } = useParams();
  const { names } = useVocabulary();
  const order = useQuery({
    queryKey: queryKeys.order(projectId),
    queryFn: () => getOrder(projectId),
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

  const items = order.data?.items ?? [];
  const dependencies = order.data?.dependencies ?? [];

  return (
    <div className="stack">
      <PageHeading
        kicker="Order"
        title="Order"
        lead={`The queue of ${plural(names.workItem)}. Open a row to enter the work room.`}
      />
      {order.isPending ? <Loading>Loading the queue…</Loading> : null}
      {order.isError ? <ErrorNote error={order.error} /> : null}
      {order.data && items.length === 0 ? (
        <Empty>The queue is empty. Add a work item, or plan work items from an instruction.</Empty>
      ) : null}
      <ul className="plain-list">
        {items.map((item) => {
          const dependsOn = dependencies.filter((row) => row.workItemId === item.id);
          const neededBy = dependencies.filter((row) => row.dependsOnId === item.id);
          const owner = members.data?.find((member) => member.userId === item.ownerUserId);
          const shipped = item.status === "done";
          const room = `/p/${projectId}/order/${item.id}`;
          return (
            <li key={item.id} className="list-card stack">
              <h2>{shipped ? <Link to={room}>{item.title}</Link> : item.title}</h2>
              {shipped ? (
                <p>
                  <StatusTag status="Shipped" />
                </p>
              ) : (
                <p>
                  Status: <StatusTag status={item.status} />
                </p>
              )}
              {ownerText(owner, item.ownerUserId) ? (
                <p>Owner: {ownerText(owner, item.ownerUserId)}</p>
              ) : null}
              {!isBlankFact(item.blockedReason) ? <p>Blocked: {item.blockedReason}</p> : null}
              {!shipped && !isBlankFact(item.shipCommit) ? (
                <p className="mono">Ship commit: {item.shipCommit}</p>
              ) : null}
              {item.parentId && !isBlankFact(item.parentId) ? (
                <p>
                  Parent:{" "}
                  <Link to={`/p/${projectId}/order/${item.parentId}`}>
                    {titleFor(items, item.parentId)}
                  </Link>
                </p>
              ) : null}
              {dependsOn.length > 0 ? (
                <p>Depends on: {dependsOn.map((row) => titleFor(items, row.dependsOnId)).join(", ")}</p>
              ) : null}
              {neededBy.length > 0 ? (
                <p>Needed by: {neededBy.map((row) => titleFor(items, row.workItemId)).join(", ")}</p>
              ) : null}
              {item.scopePaths.length > 0 ? (
                <ul>
                  {item.scopePaths.map((scopePath) => (
                    <li key={scopePath}>
                      <code>{scopePath}</code>
                    </li>
                  ))}
                </ul>
              ) : null}
              {shipped ? null : <Link to={room}>Open work room</Link>}
            </li>
          );
        })}
      </ul>
      <AddForm
        projectId={projectId}
        items={items.map((item) => ({ id: item.id, title: item.title }))}
        members={members.data ?? []}
      />
      <PlanForm projectId={projectId} />
    </div>
  );
}

function titleFor(items: Array<{ id: string; title: string }>, id: string): string {
  return items.find((item) => item.id === id)?.title ?? id;
}

function ownerText(
  owner: { name: string; email: string } | undefined,
  ownerUserId: string | null
): string | null {
  const text = owner ? `${owner.name} (${owner.email})` : ownerUserId;
  return isBlankFact(text) ? null : text;
}

function AddForm({
  projectId,
  items,
  members,
}: {
  projectId: string;
  items: Array<{ id: string; title: string }>;
  members: Array<{ userId: string; name: string; email: string }>;
}) {
  const { names } = useVocabulary();
  const queryClient = useQueryClient();
  const base = useId();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [scopeText, setScopeText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      const scopePaths = linesToList(scopeText);
      return createWorkItem(projectId, {
        title: title.trim(),
        body,
        ...(dependsOn.length > 0 ? { dependsOnIds: dependsOn } : {}),
        ...(ownerUserId ? { ownerUserId } : {}),
        ...(scopePaths.length > 0 ? { scopePaths } : {}),
      });
    },
    onSuccess: async () => {
      setTitle("");
      setBody("");
      setOwnerUserId("");
      setDependsOn([]);
      setScopeText("");
      setNotice(`${cap(names.workItem)} added.`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.order(projectId) });
    },
  });

  function toggleDepend(id: string, checked: boolean) {
    setDependsOn((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  }

  return (
    <form
      className="card stack"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setNotice(null);
        mutation.mutate();
      }}
    >
      <h2>Add {names.workItem}</h2>
      <div className="field">
        <label htmlFor={`${base}-title`}>Title</label>
        <input
          id={`${base}-title`}
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${base}-body`}>Body</label>
        <textarea
          id={`${base}-body`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <details>
        <summary>More detail</summary>
        <div className="stack">
          <div className="field">
            <label htmlFor={`${base}-owner`}>Owner</label>
            <select
              id={`${base}-owner`}
              value={ownerUserId}
              onChange={(event) => setOwnerUserId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name} ({member.email})
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend>Depends on</legend>
            {items.length === 0 ? (
              <p className="hint">The queue has no other work items to depend on.</p>
            ) : (
              <div className="check-list">
                {items.map((item) => (
                  <label key={item.id} className="choice">
                    <input
                      type="checkbox"
                      checked={dependsOn.includes(item.id)}
                      onChange={(event) => toggleDepend(item.id, event.target.checked)}
                    />
                    <span>{item.title}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="field">
            <label htmlFor={`${base}-scope`}>Scope paths</label>
            <textarea
              id={`${base}-scope`}
              spellCheck={false}
              value={scopeText}
              onChange={(event) => setScopeText(event.target.value)}
              aria-describedby={`${base}-scope-hint`}
            />
            <p className="hint" id={`${base}-scope-hint`}>
              One path per line.
            </p>
          </div>
        </div>
      </details>
      <ErrorNote error={mutation.error} />
      <Notice>{notice}</Notice>
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Adding…" : `Add ${names.workItem}`}
      </button>
    </form>
  );
}

function PlanForm({ projectId }: { projectId: string }) {
  const { names } = useVocabulary();
  const queryClient = useQueryClient();
  const instructionId = useId();
  const [instruction, setInstruction] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [ack, setAck] = useState<Ack | null>(null);
  const mutation = useMutation({
    mutationFn: (text: string) => planWork(projectId, text),
    onSuccess: async (result) => {
      setAck(result);
      setInstruction("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.order(projectId) });
    },
  });

  return (
    <details className="quiet-disclosure">
      <summary>Plan {plural(names.workItem)}</summary>
      <form
        className="stack"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          setAck(null);
          if (!instruction.trim()) {
            setFormError("Write an instruction to plan work items.");
            return;
          }
          setFormError(null);
          mutation.mutate(instruction.trim());
        }}
      >
        <div className="field">
          <label htmlFor={instructionId}>Instruction</label>
          <textarea
            id={instructionId}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </div>
        <ErrorNote error={formError ? new Error(formError) : mutation.error} />
        <AckNote ack={ack} />
        <button type="submit" className="quiet" disabled={mutation.isPending}>
          {mutation.isPending ? "Planning…" : `Plan ${plural(names.workItem)}`}
        </button>
      </form>
    </details>
  );
}
