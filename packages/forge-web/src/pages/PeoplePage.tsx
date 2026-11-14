import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ROLES,
  createInvite,
  getHome,
  getMembers,
  getSession,
  queryKeys,
  updateMemberRole,
  type Member,
} from "../api";
import { cap } from "../text";
import { Empty, ErrorNote, Loading, Notice, PageHeading, StatusTag } from "../ui";

export function PeoplePage() {
  const home = useQuery({ queryKey: queryKeys.home, queryFn: getHome });
  const [params, setParams] = useSearchParams();
  const [picked, setPicked] = useState<string | null>(null);
  const requested = params.get("team") ?? "";
  const teams = home.data?.teams ?? [];
  const teamId =
    picked && teams.some((team) => team.id === picked)
      ? picked
      : teams.some((team) => team.id === requested)
        ? requested
        : (teams[0]?.id ?? "");
  const team = teams.find((item) => item.id === teamId);
  const selectId = useId();

  function choose(next: string) {
    setPicked(next);
    setParams(next ? { team: next } : {});
  }

  return (
    <div className="stack">
      <PageHeading
        kicker="People"
        title="People"
        lead="Choose a team, change roles, and create an invite. The invite token is shown once."
      />
      {home.isPending ? <Loading>Loading teams…</Loading> : null}
      {home.isError ? <ErrorNote error={home.error} /> : null}
      {home.data && teams.length === 0 ? (
        <Empty>Create a team on Home, then come back to invite people.</Empty>
      ) : null}
      {teamId ? (
        <section className="card stack">
          <div className="field">
            <label htmlFor={selectId}>Team</label>
            <select id={selectId} value={teamId} onChange={(event) => choose(event.target.value)}>
              {teams.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          {team ? (
            <p>
              Your role on {team.name}: <StatusTag status={team.role || "unknown"} />
            </p>
          ) : null}
          <Members teamId={teamId} />
          <InviteForm teamId={teamId} />
        </section>
      ) : null}
    </div>
  );
}

function Members({ teamId }: { teamId: string }) {
  const members = useQuery({
    queryKey: queryKeys.members(teamId),
    queryFn: () => getMembers(teamId),
  });
  const session = useQuery({ queryKey: queryKeys.session, queryFn: getSession });

  return (
    <div className="stack">
      <h2>Members</h2>
      {members.isPending ? <Loading>Loading members…</Loading> : null}
      {members.isError ? <ErrorNote error={members.error} /> : null}
      {members.data && members.data.length === 0 ? (
        <Empty>No members yet. Create an invite and share the token once.</Empty>
      ) : null}
      {members.data?.map((member) => (
        <MemberRow
          key={member.userId}
          teamId={teamId}
          member={member}
          isYou={session.data?.id === member.userId}
        />
      ))}
    </div>
  );
}

function MemberRow({ teamId, member, isYou }: { teamId: string; member: Member; isYou: boolean }) {
  const queryClient = useQueryClient();
  const selectId = useId();
  const [role, setRole] = useState(member.role);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const choices = (ROLES as readonly string[]).includes(member.role)
    ? [...ROLES]
    : [member.role, ...ROLES];

  useEffect(() => {
    if (!dirty) setRole(member.role);
  }, [member.role, dirty]);

  const mutation = useMutation({
    mutationFn: () => updateMemberRole(teamId, member.userId, role),
    onSuccess: async () => {
      setDirty(false);
      setNotice(`Role saved for ${member.name}.`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.members(teamId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
  });

  return (
    <form
      className="member"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setNotice(null);
        mutation.mutate();
      }}
    >
      <div>
        <h3>{member.name}</h3>
        <p>{member.email || "Email not reported"}</p>
        <p>{isYou ? "This is you." : `User id ${member.userId}`}</p>
        <p>
          Current role: <StatusTag status={member.role || "unknown"} />
        </p>
      </div>
      <div className="field">
        <label htmlFor={selectId}>Role for {member.name}</label>
        <select
          id={selectId}
          value={role}
          onChange={(event) => {
            setRole(event.target.value);
            setDirty(true);
          }}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {cap(choice)}
            </option>
          ))}
        </select>
      </div>
      <div className="actions">
        <button type="submit" className="quiet" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving role…" : "Save role"}
        </button>
        <ErrorNote error={mutation.error} />
        <Notice>{notice}</Notice>
      </div>
    </form>
  );
}

function InviteForm({ teamId }: { teamId: string }) {
  const roleId = useId();
  const tokenId = useId();
  const [role, setRole] = useState<string>("view");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createInvite(teamId, role),
    onSuccess: (invite) => {
      setToken(invite.token);
      setCopied(false);
      setCopyError(null);
    },
  });

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopied(false);
      setCopyError("Copy failed. Select the token and copy it manually.");
    }
  }

  return (
    <div className="stack">
      <h2>Invite</h2>
      <form
        className="form-narrow"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="field">
          <label htmlFor={roleId}>Invite role</label>
          <select id={roleId} value={role} onChange={(event) => setRole(event.target.value)}>
            {ROLES.map((choice) => (
              <option key={choice} value={choice}>
                {cap(choice)}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">Creating another invite replaces the token shown on this page.</p>
        <ErrorNote error={mutation.error} />
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating invite…" : "Create invite"}
        </button>
      </form>
      {token ? (
        <div className="note stack">
          <p>Copy this token now. Forge will not show it again after you hide it.</p>
          <div className="field">
            <label htmlFor={tokenId}>Invite token</label>
            <input
              id={tokenId}
              readOnly
              spellCheck={false}
              value={token}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
          <div className="actions">
            <button type="button" className="quiet" onClick={() => void copyToken()}>
              Copy token
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setToken(null);
                setCopied(false);
                setCopyError(null);
              }}
            >
              Hide token
            </button>
          </div>
          {copied ? <p role="status">Token copied.</p> : null}
          <ErrorNote error={copyError ? new Error(copyError) : null} />
        </div>
      ) : null}
    </div>
  );
}
