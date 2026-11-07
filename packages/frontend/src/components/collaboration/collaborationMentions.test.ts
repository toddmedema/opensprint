import { describe, expect, it } from "vitest";
import {
  composerEdit,
  editMentionTokens,
  mentionCompletion,
  validMentionTokens,
  type CollaborationMentionToken,
} from "./collaborationMentions";

const first: CollaborationMentionToken = { actorId: "maya-a", start: 0, end: 5, text: "@Maya" };
const second: CollaborationMentionToken = { actorId: "maya-b", start: 6, end: 11, text: "@Maya" };

describe("explicit collaboration mention ranges", () => {
  it("retains a chosen identity during ordinary typing after its token", () => {
    const before = "@Maya ";
    const after = before + "thanks";
    const edit = composerEdit({ value: before, start: 6, end: 6 }, after, "insertText");
    expect(editMentionTokens([first], before, after, edit)).toEqual([first]);
  });

  it("moves an untouched token when text is inserted before it", () => {
    const before = "@Maya ";
    const after = "Hello " + before;
    expect(editMentionTokens([first], before, after, { start: 0, end: 0 })).toEqual([
      { ...first, start: 6, end: 11 },
    ]);
  });

  it.each([
    { label: "replace all", before: "@Maya ", after: "@Ma", start: 0, end: 6 },
    { label: "replace one letter", before: "@Maya ", after: "@Maxa ", start: 3, end: 4 },
    { label: "insert inside the name", before: "@Maya ", after: "@Mayxa ", start: 4, end: 4 },
    { label: "remove the token", before: "@Maya note", after: "note", start: 0, end: 6 },
    {
      label: "paste identical text over the token",
      before: "@Maya ",
      after: "@Maya ",
      start: 0,
      end: 5,
    },
  ])("drops identity when the user chooses to $label", ({ before, after, start, end }) => {
    expect(editMentionTokens([first], before, after, { start, end })).toEqual([]);
  });

  it.each([
    { start: 0, end: 6, expected: { ...second, start: 0, end: 5 } },
    { start: 6, end: 12, expected: first },
  ])(
    "preserves the correct other actor when one identical-name token is deleted",
    ({ start, end, expected }) => {
      const before = "@Maya @Maya ";
      const after = before.slice(0, start) + before.slice(end);
      expect(editMentionTokens([first, second], before, after, { start, end })).toEqual([expected]);
    }
  );

  it("uses actual delete direction when identical text makes a minimal diff ambiguous", () => {
    expect(composerEdit({ value: "aa", start: 1, end: 1 }, "a")).toBeUndefined();
    expect(composerEdit({ value: "aa", start: 1, end: 1 }, "a", "deleteContentBackward")).toEqual({
      start: 0,
      end: 1,
    });
    expect(composerEdit({ value: "aa", start: 1, end: 1 }, "a", "deleteContentForward")).toEqual({
      start: 1,
      end: 2,
    });
  });

  it("derives a word deletion from the caret without moving another person's token", () => {
    const before = "@Maya @Maya ";
    const after = "@Maya ";
    const edit = composerEdit({ value: before, start: 6, end: 6 }, after, "deleteWordBackward");
    expect(edit).toEqual({ start: 0, end: 6 });
    expect(editMentionTokens([first, second], before, after, edit)).toEqual([
      { ...second, start: 0, end: 5 },
    ]);
  });

  it("invalidates identities when no reliable edit selection is available", () => {
    expect(editMentionTokens([first, second], "@Maya @Maya ", "@Maya ", undefined)).toEqual([]);
  });

  it("does not match a short person's name inside a longer one", () => {
    const ann = { actorId: "ann", start: 0, end: 4, text: "@Ann" };
    expect(validMentionTokens([ann], "@AnnSmith ")).toEqual([]);
    expect(validMentionTokens([ann], "@Ann Smith ")).toEqual([ann]);
    const annSmith = { actorId: "ann-smith", start: 0, end: 10, text: "@Ann Smith" };
    expect(validMentionTokens([annSmith], "@Ann Smith ")).toEqual([annSmith]);
  });

  it("requires the original range and exact text instead of searching for a familiar name", () => {
    expect(validMentionTokens([first], "Hello @Maya ")).toEqual([]);
    expect(validMentionTokens([{ ...first, start: 6, end: 11 }], "Hello @Maya ")).toHaveLength(1);
  });

  it("tracks UTF-16 textarea offsets through text containing emoji", () => {
    const before = "🌟 @Maya ";
    const token = { ...first, start: 3, end: 8 };
    expect(editMentionTokens([token], before, "★" + before, { start: 0, end: 0 })).toEqual([
      { ...token, start: 4, end: 9 },
    ]);
  });

  it("completes a selected existing token as a full replacement even when the displayed name stays identical", () => {
    expect(mentionCompletion("@Maya ", 0, 5, [first])).toEqual({ start: 0, end: 5, query: "Maya" });
    expect(editMentionTokens([first], "@Maya ", "@Maya ", { start: 0, end: 5 })).toEqual([]);
  });

  it("does not create mention identity from plain typed text", () => {
    expect(validMentionTokens([], "@Maya ")).toEqual([]);
  });

  it("does not misinterpret an autocorrection or dictation replacement as deleting one duplicate token", () => {
    const before = "@Maya @Maya ";
    expect(
      composerEdit({ value: before, start: 12, end: 12 }, "@Maya ", "insertReplacementText")
    ).toBeUndefined();
  });
});
