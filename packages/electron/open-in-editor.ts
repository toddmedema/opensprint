import { execFile as cpExecFile } from "child_process";
import fs from "fs";

export type EditorMode = "vscode" | "cursor" | "auto";

export interface OpenInEditorResult {
  success: boolean;
  editor: string;
  method: "cli" | "uri";
  error?: string;
}

export interface OpenInEditorDeps {
  execFile: typeof cpExecFile;
  openExternal: (url: string) => Promise<void>;
}

const CLI_COMMANDS: Record<"vscode" | "cursor", string> = {
  vscode: "code",
  cursor: "cursor",
};

const URI_SCHEMES: Record<"vscode" | "cursor", string> = {
  vscode: "vscode://file",
  cursor: "cursor://file",
};

const EDITOR_ORDER: ("vscode" | "cursor")[] = ["cursor", "vscode"];

function tryCliOpen(
  command: string,
  folderPath: string,
  execFile: OpenInEditorDeps["execFile"]
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, [folderPath], { timeout: 10_000 }, (err) => {
      resolve(!err);
    });
  });
}

export async function openInEditor(
  folderPath: string,
  mode: EditorMode,
  deps: OpenInEditorDeps
): Promise<OpenInEditorResult> {
  if (!folderPath || !folderPath.trim()) {
    return { success: false, editor: mode, method: "cli", error: "Folder path is required." };
  }

  try {
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      return { success: false, editor: mode, method: "cli", error: "Path is not a directory." };
    }
  } catch {
    return {
      success: false,
      editor: mode,
      method: "cli",
      error: `Path does not exist: ${folderPath}`,
    };
  }

  const editorsToTry: ("vscode" | "cursor")[] = mode === "auto" ? EDITOR_ORDER : [mode];

  for (const editor of editorsToTry) {
    const command = CLI_COMMANDS[editor];
    const ok = await tryCliOpen(command, folderPath, deps.execFile);
    if (ok) {
      return { success: true, editor, method: "cli" };
    }
  }

  for (const editor of editorsToTry) {
    const normalized = folderPath.replace(/\\/g, "/");
    const encoded = normalized
      .split("/")
      .map((part, index) =>
        index === 0 && /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)
      )
      .join("/");
    const uri = `${URI_SCHEMES[editor]}/${encoded}`;
    try {
      await deps.openExternal(uri);
      return { success: true, editor, method: "uri" };
    } catch {
      // URI scheme not registered, continue
    }
  }

  const tried = editorsToTry.map((e) => CLI_COMMANDS[e]).join(", ");
  return {
    success: false,
    editor: mode,
    method: "cli",
    error: `No editor CLI found (tried: ${tried}). Install VS Code or Cursor and ensure the CLI is in your PATH.`,
  };
}
