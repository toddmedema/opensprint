/** An explicit autocomplete choice remains bound to its actor and exact UTF-16 text range. */
export interface CollaborationMentionToken {
  actorId: string;
  start: number;
  end: number;
  text: string;
}

export interface ComposerSelection {
  value: string;
  start: number;
  end: number;
  inputType?: string;
}

export interface ComposerEdit {
  start: number;
  end: number;
}

/** Verify a replacement describes the actual edit, rather than guessing across identical names. */
function describesEdit(before: string, after: string, edit: ComposerEdit): boolean {
  const inserted = after.length - before.length + edit.end - edit.start;
  return (
    edit.start >= 0 &&
    edit.end >= edit.start &&
    edit.end <= before.length &&
    inserted >= 0 &&
    before.slice(0, edit.start) === after.slice(0, edit.start) &&
    before.slice(edit.end) === after.slice(edit.start + inserted)
  );
}

/** Use the real pre-edit selection and input direction; ambiguous edits invalidate identities. */
export function composerEdit(
  selection: ComposerSelection | undefined,
  after: string,
  inputType?: string
): ComposerEdit | undefined {
  if (!selection) return undefined;
  const { value: before, start, end } = selection;
  if (start !== end)
    return describesEdit(before, after, { start, end }) ? { start, end } : undefined;
  const change = after.length - before.length;
  if (change >= 0) return describesEdit(before, after, { start, end }) ? { start, end } : undefined;
  const direction = inputType || selection.inputType;
  if (direction && !direction.startsWith("delete")) return undefined;
  const backward = { start: start + change, end };
  const forward = { start, end: end - change };
  const candidates = direction?.includes("Backward")
    ? [backward]
    : direction?.includes("Forward")
      ? [forward]
      : [backward, forward];
  const valid = candidates.filter((candidate) => describesEdit(before, after, candidate));
  return valid.length === 1 ? valid[0] : undefined;
}

/** Keep only intact explicit tokens; a plain display-name match never creates a notification. */
export function validMentionTokens(
  tokens: CollaborationMentionToken[],
  value: string
): CollaborationMentionToken[] {
  return tokens.filter(
    (token) =>
      token.start >= 0 &&
      token.end > token.start &&
      token.end <= value.length &&
      value.slice(token.start, token.end) === token.text &&
      token.text.startsWith("@") &&
      (token.start === 0 || /[\s([{]/.test(value[token.start - 1]!)) &&
      (token.end === value.length || /[\s.,!?;:)\]}]/.test(value[token.end]!))
  );
}

/** Move untouched token ranges, dropping any token whose identity-bearing text was edited. */
export function editMentionTokens(
  tokens: CollaborationMentionToken[],
  before: string,
  after: string,
  edit: ComposerEdit | undefined
): CollaborationMentionToken[] {
  if (!edit || !describesEdit(before, after, edit)) return [];
  const delta = after.length - before.length;
  const updated = validMentionTokens(tokens, before).flatMap((token) => {
    const overlaps = edit.start < token.end && edit.end > token.start;
    const insertsInside =
      edit.start === edit.end && edit.start > token.start && edit.start < token.end;
    if (overlaps || insertsInside) return [];
    return [
      edit.end <= token.start
        ? { ...token, start: token.start + delta, end: token.end + delta }
        : token,
    ];
  });
  return validMentionTokens(updated, after);
}

/** Find the text range being completed, including an existing selected token with identical text. */
export function mentionCompletion(
  value: string,
  start: number,
  end: number,
  tokens: CollaborationMentionToken[]
) {
  const existing = validMentionTokens(tokens, value).find(
    (token) =>
      (start < end && start >= token.start && end <= token.end) ||
      (start === end && start > token.start && start <= token.end)
  );
  if (existing) return { start: existing.start, end: existing.end, query: existing.text.slice(1) };
  const prefix = value.slice(0, end);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
  return match ? { start: prefix.length - match[1]!.length - 1, end, query: match[1]! } : null;
}
