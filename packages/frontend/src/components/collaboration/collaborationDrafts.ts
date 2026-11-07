import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CollaborationMentionToken } from "./collaborationMentions";
import type { CollaborationContext } from "@opensprint/shared";

/** In-memory composition state belongs to the project view, independent of dock visibility. */
export interface CollaborationDraftState {
  drafts: Record<string, string>;
  contexts: Record<string, CollaborationContext | undefined>;
  decisions: Record<string, boolean>;
  mentions: Record<string, string[]>;
  mentionTokens: Record<string, CollaborationMentionToken[]>;
  guidanceDrafts: Record<string, Record<string, string>>;
  messageIdentities: Record<string, { payload: string; id: string } | undefined>;
  guidanceIdentities: Record<string, { payload: string; id: string } | undefined>;
}
/** Create fresh draft maps so projects and new connections never share mutable composition state. */
export function emptyCollaborationDrafts(): CollaborationDraftState {
  return {
    drafts: {},
    contexts: {},
    decisions: {},
    mentions: {},
    mentionTokens: {},
    guidanceDrafts: {},
    messageIdentities: {},
    guidanceIdentities: {},
  };
}
export interface CollaborationDraftOwner {
  state: CollaborationDraftState;
  update: Dispatch<SetStateAction<CollaborationDraftState>>;
}
/**
 * Retain drafts and uncertain-retry identities across dock closes, but discard them on a
 * project change. Updates captured by an earlier project cannot overwrite the current draft.
 */
export function useProjectCollaborationDrafts(projectId: string): CollaborationDraftOwner {
  const project = useRef(projectId);
  project.current = projectId;
  const [state, setState] = useState(() => ({ projectId, drafts: emptyCollaborationDrafts() }));
  useEffect(() => {
    setState((previous) =>
      previous.projectId === projectId
        ? previous
        : { projectId, drafts: emptyCollaborationDrafts() }
    );
  }, [projectId]);
  const update = useCallback<Dispatch<SetStateAction<CollaborationDraftState>>>(
    (next) => {
      if (project.current !== projectId) return;
      setState((previous) => ({
        projectId,
        drafts:
          typeof next === "function"
            ? next(previous.projectId === projectId ? previous.drafts : emptyCollaborationDrafts())
            : next,
      }));
    },
    [projectId]
  );
  return {
    state: state.projectId === projectId ? state.drafts : emptyCollaborationDrafts(),
    update,
  };
}
