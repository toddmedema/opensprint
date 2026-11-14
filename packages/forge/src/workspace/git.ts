import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CredentialSecret, ProjectRecord } from "../domain.js";
import { ForgeError } from "../errors.js";
import { redactText, sanitizedEnv } from "../redact.js";
import { isLocalRemote } from "../runbook/runbook.js";
import { setTreeWritable } from "./freeze.js";

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type ShipResult =
  | { ok: true; commit: string }
  | {
      ok: false;
      reason: "conflict" | "nothing_to_ship" | "push_failed" | "base_moved" | "merge_incomplete";
      detail: string;
    };

export class GitWorkspace {
  private readonly hooksDir: string;
  private readonly emptyConfig: string;
  private readonly askpassPath: string;

  constructor(private readonly dataDir: string) {
    this.hooksDir = path.join(dataDir, "git-hooks");
    this.emptyConfig = path.join(dataDir, "gitconfig");
    this.askpassPath = path.join(dataDir, "askpass.mjs");
    fs.mkdirSync(this.hooksDir, { recursive: true });
    this.resetGitBoundary();
    this.writeAskpass();
  }

  checkoutPath(projectId: string): string {
    return path.join(this.dataDir, "checkouts", projectId);
  }

  async createScratchRepository(): Promise<string> {
    const dest = path.resolve(this.dataDir, "origins", randomBytes(8).toString("hex"));
    const temp = path.resolve(this.dataDir, "tmp", randomBytes(8).toString("hex"));
    fs.mkdirSync(dest, { recursive: true });
    fs.mkdirSync(path.dirname(temp), { recursive: true });
    const discard = () => {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    };
    const initialized = await this.git(dest, ["init", "--bare", "-b", "main"], []);
    if (initialized.code !== 0) {
      discard();
      throw new ForgeError(
        500,
        "git_failed",
        redactText(initialized.stderr || initialized.stdout || "git init failed")
      );
    }
    const cloned = await this.git(undefined, ["clone", dest, temp], []);
    if (cloned.code !== 0) {
      discard();
      throw new ForgeError(500, "git_failed", redactText(cloned.stderr || cloned.stdout || "git clone failed"));
    }
    const committed = await this.git(temp, ["commit", "--allow-empty", "-m", "Start"], []);
    if (committed.code !== 0) {
      discard();
      throw new ForgeError(
        500,
        "git_failed",
        redactText(committed.stderr || committed.stdout || "git commit failed")
      );
    }
    const pushed = await this.git(temp, ["push", "origin", "HEAD:main"], []);
    fs.rmSync(temp, { recursive: true, force: true });
    if (pushed.code !== 0) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new ForgeError(500, "git_failed", redactText(pushed.stderr || pushed.stdout || "git push failed"));
    }
    return dest;
  }

  worktreePath(projectId: string, workItemId: string): string {
    return path.join(this.dataDir, "worktrees", projectId, workItemId.replaceAll("/", "_"));
  }

  async ensureCheckout(project: ProjectRecord, credential: CredentialSecret): Promise<string> {
    const dest = this.checkoutPath(project.id);
    if (fs.existsSync(path.join(dest, ".git"))) return dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await this.clone(project.remoteUrl, dest, project.baseBranch, credential);
    return dest;
  }

  async prepareMirror(project: ProjectRecord, credential: CredentialSecret): Promise<string> {
    const dest = path.join(this.dataDir, "discovery", project.id);
    if (fs.existsSync(dest)) {
      setTreeWritable(dest, true);
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await this.clone(project.remoteUrl, dest, project.baseBranch, credential);
    setTreeWritable(dest, false);
    return dest;
  }

  async ensureWorktree(
    project: ProjectRecord,
    workItemId: string,
    sha: string,
    credential: CredentialSecret
  ): Promise<string> {
    const checkout = await this.ensureCheckout(project, credential);
    const dest = this.worktreePath(project.id, workItemId);
    if (fs.existsSync(path.join(dest, ".git"))) return dest;
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const branch = `forge/${workItemId}`;
    const created = await this.git(checkout, ["worktree", "add", "-b", branch, dest, sha], []);
    if (created.code === 0) return dest;
    const existing = await this.git(checkout, ["worktree", "add", dest, branch], []);
    if (existing.code !== 0) {
      throw new ForgeError(500, "worktree_failed", redactText(created.stderr + existing.stderr));
    }
    return dest;
  }

  async addProbe(checkout: string, sha: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = path.join(this.dataDir, "probes", randomBytes(4).toString("hex"));
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const added = await this.git(checkout, ["worktree", "add", "--detach", dir, sha], []);
    if (added.code !== 0) {
      throw new ForgeError(500, "probe_failed", redactText(added.stderr));
    }
    return {
      dir,
      cleanup: async () => {
        await this.git(checkout, ["worktree", "remove", "--force", dir], []);
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  async revParse(repo: string, ref: string): Promise<string> {
    const result = await this.git(repo, ["rev-parse", ref], []);
    if (result.code !== 0) {
      throw new ForgeError(500, "git_failed", redactText(result.stderr || `Missing ref ${ref}`));
    }
    return result.stdout.trim();
  }

  async changedFiles(worktree: string, baseBranch: string): Promise<string[]> {
    const lists = await Promise.all([
      this.git(worktree, ["diff", "--name-only", `${baseBranch}...HEAD`], [], {}, { raw: true }),
      this.git(worktree, ["diff", "--name-only", "--cached"], [], {}, { raw: true }),
      this.git(worktree, ["diff", "--name-only"], [], {}, { raw: true }),
      this.git(worktree, ["ls-files", "--others", "--exclude-standard"], [], {}, { raw: true }),
    ]);
    const names = lists
      .flatMap((result) => result.stdout.split("\n"))
      .map((line) => line.trim())
      .filter(Boolean);
    return [...new Set(names)];
  }

  async diffText(worktree: string, baseBranch: string): Promise<string> {
    const committed = await this.git(worktree, ["diff", `${baseBranch}...HEAD`], []);
    const dirty = await this.git(worktree, ["diff"], []);
    return `${committed.stdout}${dirty.stdout}`;
  }

  async unpushedDiff(worktree: string, baseBranch: string): Promise<string> {
    const patch = await this.git(worktree, ["diff", `origin/${baseBranch}`], []);
    return patch.code === 0 ? patch.stdout : "";
  }

  async shipDiff(repo: string, commit: string): Promise<string> {
    const merged = await this.git(repo, ["diff", `${commit}^1`, commit], []);
    if (merged.code === 0 && merged.stdout.trim()) return merged.stdout;
    const shown = await this.git(repo, ["show", "--format=", commit], []);
    return shown.code === 0 ? shown.stdout : "";
  }

  async commitLeftovers(worktree: string, message: string): Promise<"clean" | "committed"> {
    const status = await this.git(worktree, ["status", "--porcelain"], []);
    if (status.code !== 0) throw new ForgeError(500, "git_failed", redactText(status.stderr));
    if (!status.stdout.trim()) return "clean";
    const added = await this.git(worktree, ["add", "-A"], []);
    if (added.code !== 0) throw new ForgeError(500, "git_failed", redactText(added.stderr));
    const committed = await this.git(worktree, ["commit", "-m", message], []);
    if (committed.code !== 0) throw new ForgeError(500, "git_failed", redactText(committed.stderr));
    return "committed";
  }

  async ship(input: {
    checkout: string;
    baseBranch: string;
    taskBranch: string;
    message: string;
    credential: CredentialSecret;
    remoteUrl: string;
  }): Promise<ShipResult> {
    const secrets = secretValues(input.credential);
    const fetched = await this.git(input.checkout, ["fetch", "origin"], secrets);
    if (fetched.code !== 0) return { ok: false, reason: "push_failed", detail: fetched.stderr };
    if (await this.merging(input.checkout)) {
      await this.git(input.checkout, ["merge", "--abort"], secrets);
      return { ok: false, reason: "merge_incomplete", detail: "A merge was already in progress." };
    }
    const ff = await this.git(input.checkout, ["merge", "--ff-only", `origin/${input.baseBranch}`], secrets);
    if (ff.code !== 0) return { ok: false, reason: "base_moved", detail: ff.stderr };
    const before = (await this.git(input.checkout, ["rev-parse", "HEAD"], secrets)).stdout.trim();
    const merge = await this.git(
      input.checkout,
      ["merge", "--no-ff", input.taskBranch, "-m", input.message],
      secrets
    );
    if (merge.code !== 0) {
      await this.git(input.checkout, ["merge", "--abort"], secrets);
      return { ok: false, reason: "conflict", detail: `${merge.stdout}\n${merge.stderr}` };
    }
    const after = (await this.git(input.checkout, ["rev-parse", "HEAD"], secrets)).stdout.trim();
    if (!after || after === before) {
      return { ok: false, reason: "nothing_to_ship", detail: "Merge did not create a commit." };
    }
    const pushed = await this.push(input.checkout, input.baseBranch, input.credential, input.remoteUrl);
    if (!pushed.ok) return { ok: false, reason: "push_failed", detail: pushed.detail };
    const remote = await this.remoteTip(input.checkout, input.baseBranch, secrets);
    if (remote !== after) {
      return { ok: false, reason: "push_failed", detail: "Remote base does not match the merge commit." };
    }
    return { ok: true, commit: after };
  }

  private async merging(repo: string): Promise<boolean> {
    const result = await this.git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], []);
    return result.code === 0;
  }

  private async remoteTip(repo: string, baseBranch: string, secrets: string[]): Promise<string> {
    const result = await this.git(repo, ["ls-remote", "origin", `refs/heads/${baseBranch}`], secrets);
    return result.stdout.split(/\s+/)[0] ?? "";
  }

  private async push(
    checkout: string,
    baseBranch: string,
    credential: CredentialSecret,
    remoteUrl: string
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const args = ["push", "origin", `HEAD:${baseBranch}`];
    const result =
      credential.type === "https_token" && !isLocalRemote(remoteUrl)
        ? await this.withAskpass(credential, (env) => this.git(checkout, args, secretValues(credential), env))
        : await this.git(checkout, args, secretValues(credential));
    return result.code === 0 ? { ok: true } : { ok: false, detail: result.stderr };
  }

  private async clone(
    url: string,
    dest: string,
    branch: string,
    credential: CredentialSecret
  ): Promise<void> {
    const args = ["clone", "--branch", branch, "--single-branch", url, dest];
    const result =
      credential.type === "https_token" && !isLocalRemote(url)
        ? await this.withAskpass(credential, (env) => this.git(undefined, args, secretValues(credential), env))
        : await this.git(undefined, args, secretValues(credential));
    if (result.code !== 0) {
      throw new ForgeError(400, "clone_failed", redactText(result.stderr || result.stdout, secretValues(credential)));
    }
  }

  private async withAskpass(
    credential: CredentialSecret,
    run: (env: NodeJS.ProcessEnv) => Promise<GitOutput>
  ): Promise<GitOutput> {
    const file = path.join(this.dataDir, `askpass-${randomBytes(6).toString("hex")}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ username: credential.username ?? "git", token: credential.token ?? "" }),
      { mode: 0o600 }
    );
    try {
      return await run({ FORGE_ASKPASS_FILE: file, GIT_ASKPASS: this.askpassPath, GIT_TERMINAL_PROMPT: "0" });
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  private resetGitBoundary(): void {
    fs.writeFileSync(this.emptyConfig, "", { mode: 0o600 });
    fs.mkdirSync(this.hooksDir, { recursive: true });
    for (const entry of fs.readdirSync(this.hooksDir)) {
      fs.rmSync(path.join(this.hooksDir, entry), { recursive: true, force: true });
    }
  }

  private git(
    cwd: string | undefined,
    args: string[],
    secrets: string[],
    extraEnv: NodeJS.ProcessEnv = {},
    options: { raw?: boolean } = {}
  ): Promise<GitOutput> {
    this.resetGitBoundary();
    const prefix = [
      "-c",
      `core.hooksPath=${this.hooksDir}`,
      "-c",
      "user.name=Open Sprint",
      "-c",
      "user.email=forge@opensprint.local",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "safe.directory=*",
    ];
    const env = sanitizedEnv(process.env, secrets, {
      GIT_CONFIG_GLOBAL: this.emptyConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Open Sprint",
      GIT_AUTHOR_EMAIL: "forge@opensprint.local",
      GIT_COMMITTER_NAME: "Open Sprint",
      GIT_COMMITTER_EMAIL: "forge@opensprint.local",
      ...extraEnv,
    });
    return new Promise((resolve) => {
      const child = spawn("git", [...prefix, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 200_000) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 200_000) stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        resolve({ code: 127, stdout, stderr: redactText(`${stderr}\n${error.message}`, secrets) });
      });
      child.once("exit", (code) => {
        resolve({
          code: code ?? 1,
          stdout: options.raw ? stdout : redactText(stdout, secrets),
          stderr: redactText(stderr, secrets),
        });
      });
    });
  }

  private writeAskpass(): void {
    const source = `#!/usr/bin/env node
import fs from "node:fs";
const prompt = process.argv[2] ?? "";
const payload = JSON.parse(fs.readFileSync(process.env.FORGE_ASKPASS_FILE, "utf8"));
const value = /username/i.test(prompt) ? payload.username : payload.token;
process.stdout.write(String(value ?? "") + "\\n");
`;
    fs.writeFileSync(this.askpassPath, source, { mode: 0o700 });
  }
}

function secretValues(credential: CredentialSecret): string[] {
  return [credential.token ?? "", ...Object.values(credential.env ?? {})].filter((value) => value.length > 0);
}
