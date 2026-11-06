import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { collaborationApi } from "../../api/collaboration";

/** Show deduplicated project presence and entry actions without owning the shared session. */
export function CollaborationLauncher({
  projectId,
  open,
  onOpen,
  onInvite,
}: {
  projectId: string;
  open: boolean;
  onOpen: () => void;
  onInvite: () => void;
}) {
  const client = useMemo(() => collaborationApi(projectId), [projectId]);
  const presence = useQuery({
    queryKey: ["collaboration-presence", projectId],
    queryFn: ({ signal }) => client.presence(signal),
    refetchInterval: 10000,
    retry: false,
    gcTime: 0,
  });
  const people = Array.from(
    new Map((presence.data ?? []).map((person) => [person.actorId, person])).values()
  );
  return (
    <div className="flex shrink-0 items-center gap-2">
      {people.length > 0 && (
        <span
          className="hidden items-center -space-x-1 sm:flex"
          aria-label={`${people.length} people collaborating`}
        >
          {people.slice(0, 3).map((person) => (
            <span
              key={person.actorId}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-theme-bg bg-theme-surface-muted text-[10px] text-theme-muted"
              title={person.displayName}
            >
              {person.displayName.slice(0, 2).toUpperCase()}
            </span>
          ))}
        </span>
      )}
      <button type="button" className="btn-secondary text-xs" aria-pressed={open} onClick={onOpen}>
        Collaborate
      </button>
      <button type="button" className="btn-secondary text-xs" onClick={onInvite}>
        Invite
      </button>
    </div>
  );
}
