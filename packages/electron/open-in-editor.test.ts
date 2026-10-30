import { describe, it, expect, vi, beforeEach } from "vitest";
import { openInEditor, type OpenInEditorDeps } from "./open-in-editor";
import type { execFile as cpExecFile } from "child_process";

vi.mock("fs", () => ({
  default: {
    statSync: vi.fn(),
  },
}));

import fs from "fs";

type ExecFileCallback = Parameters<typeof cpExecFile>[3] extends infer CB
  ? CB extends (...args: infer _A) => void
    ? CB
    : never
  : never;

function makeDeps(overrides: Partial<OpenInEditorDeps> = {}): OpenInEditorDeps {
  return {
    execFile: vi.fn() as unknown as typeof cpExecFile,
    openExternal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function stubExecFileSuccess(...successCommands: string[]): typeof cpExecFile {
  return vi.fn((cmd: string, _args: unknown, _opts: unknown, cb: ExecFileCallback) => {
    if (successCommands.includes(cmd as string)) {
      (cb as (err: Error | null) => void)(null);
    } else {
      (cb as (err: Error | null) => void)(new Error(`Command not found: ${cmd}`));
    }
  }) as unknown as typeof cpExecFile;
}

function stubExecFileAllFail(): typeof cpExecFile {
  return vi.fn((_cmd: string, _args: unknown, _opts: unknown, cb: ExecFileCallback) => {
    (cb as (err: Error | null) => void)(new Error("not found"));
  }) as unknown as typeof cpExecFile;
}

beforeEach(() => {
  vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<
    typeof fs.statSync
  >);
});

describe("openInEditor", () => {
  it("opens VS Code via CLI when mode is vscode", async () => {
    const execFileMock = stubExecFileSuccess("code");
    const deps = makeDeps({ execFile: execFileMock });
    const result = await openInEditor("/tmp/worktree", "vscode", deps);

    expect(result).toEqual({ success: true, editor: "vscode", method: "cli" });
    expect(execFileMock).toHaveBeenCalledWith(
      "code",
      ["/tmp/worktree"],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function)
    );
  });

  it("opens Cursor via CLI when mode is cursor", async () => {
    const execFileMock = stubExecFileSuccess("cursor");
    const deps = makeDeps({ execFile: execFileMock });
    const result = await openInEditor("/tmp/worktree", "cursor", deps);

    expect(result).toEqual({ success: true, editor: "cursor", method: "cli" });
    expect(execFileMock).toHaveBeenCalledWith(
      "cursor",
      ["/tmp/worktree"],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function)
    );
  });

  it("tries Cursor first then VS Code in auto mode", async () => {
    const execFileMock = stubExecFileSuccess("code");
    const deps = makeDeps({ execFile: execFileMock });
    const result = await openInEditor("/tmp/worktree", "auto", deps);

    expect(result).toEqual({ success: true, editor: "vscode", method: "cli" });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect((execFileMock as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("cursor");
    expect((execFileMock as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe("code");
  });

  it("uses Cursor CLI if available first in auto mode", async () => {
    const execFileMock = stubExecFileSuccess("cursor");
    const deps = makeDeps({ execFile: execFileMock });
    const result = await openInEditor("/tmp/worktree", "auto", deps);

    expect(result).toEqual({ success: true, editor: "cursor", method: "cli" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to URI scheme when CLI is missing", async () => {
    const execFileMock = stubExecFileAllFail();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ execFile: execFileMock, openExternal });
    const result = await openInEditor("/tmp/worktree", "vscode", deps);

    expect(result).toEqual({ success: true, editor: "vscode", method: "uri" });
    expect(openExternal).toHaveBeenCalledWith("vscode://file//tmp/worktree");
  });

  it("encodes URI fallback paths with spaces", async () => {
    const execFileMock = stubExecFileAllFail();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ execFile: execFileMock, openExternal });
    const result = await openInEditor("/tmp/My Repo/worktree", "vscode", deps);

    expect(result).toEqual({ success: true, editor: "vscode", method: "uri" });
    expect(openExternal).toHaveBeenCalledWith("vscode://file//tmp/My%20Repo/worktree");
  });

  it("falls back to cursor URI in cursor mode when CLI fails", async () => {
    const execFileMock = stubExecFileAllFail();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ execFile: execFileMock, openExternal });
    const result = await openInEditor("/tmp/worktree", "cursor", deps);

    expect(result).toEqual({ success: true, editor: "cursor", method: "uri" });
    expect(openExternal).toHaveBeenCalledWith("cursor://file//tmp/worktree");
  });

  it("returns structured error when all methods fail", async () => {
    const execFileMock = stubExecFileAllFail();
    const openExternal = vi.fn().mockRejectedValue(new Error("no handler"));
    const deps = makeDeps({ execFile: execFileMock, openExternal });
    const result = await openInEditor("/tmp/worktree", "vscode", deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No editor CLI found");
    expect(result.error).toContain("code");
  });

  it("returns error for empty folder path", async () => {
    const deps = makeDeps();
    const result = await openInEditor("", "vscode", deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Folder path is required");
  });

  it("returns error for non-existent path", async () => {
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const deps = makeDeps();
    const result = await openInEditor("/nonexistent", "vscode", deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Path does not exist");
  });

  it("returns error when path is not a directory", async () => {
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
    } as ReturnType<typeof fs.statSync>);
    const deps = makeDeps();
    const result = await openInEditor("/tmp/somefile.txt", "vscode", deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not a directory");
  });

  it("auto mode tries all URIs when all CLIs fail", async () => {
    const execFileMock = stubExecFileAllFail();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ execFile: execFileMock, openExternal });
    const result = await openInEditor("/tmp/worktree", "auto", deps);

    expect(result.success).toBe(true);
    expect(result.method).toBe("uri");
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("cursor://file//tmp/worktree");
  });

  it("auto mode falls through cursor URI to vscode URI", async () => {
    const execFileMock = stubExecFileAllFail();
    const openExternal = vi
      .fn()
      .mockRejectedValueOnce(new Error("cursor not registered"))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({ execFile: execFileMock, openExternal });
    const result = await openInEditor("/tmp/worktree", "auto", deps);

    expect(result.success).toBe(true);
    expect(result.editor).toBe("vscode");
    expect(result.method).toBe("uri");
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});

it.each(["vscode", "cursor"] as const)(
  "encodes filesystem delimiters for %s URI fallback",
  async (editor) => {
    for (const folder of ["/tmp/日本 #?% folder/repo", "C:\\Users\\Todd #?%\\日本 Repo"]) {
      const deps = makeDeps({ execFile: stubExecFileAllFail() });
      expect((await openInEditor(folder, editor, deps)).method).toBe("uri");
      const normalized = folder.replace(/\\/g, "/");
      const uri = vi.mocked(deps.openExternal).mock.calls[0][0];
      expect(uri).toBe(
        editor +
          "://file/" +
          normalized
            .split("/")
            .map((part, i) =>
              i === 0 && /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)
            )
            .join("/")
      );
      const parsed = new URL(uri);
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");
      expect(decodeURIComponent(parsed.pathname.slice(1))).toBe(normalized);
    }
  }
);
