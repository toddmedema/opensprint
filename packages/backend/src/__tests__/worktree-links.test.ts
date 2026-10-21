import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unlinkWorktreeLinks } from "../utils/worktree-links.js";

let fixture: string | undefined;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

it("unlinks nested worktree junctions without touching their shared targets", async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-links-"));
  const shared = path.join(fixture, "shared");
  const workspace = path.join(fixture, "workspace");
  await fs.mkdir(shared);
  await fs.mkdir(path.join(workspace, "packages", "app"), { recursive: true });
  await fs.writeFile(path.join(shared, "keep.txt"), "shared dependency");
  const links = [
    path.join(workspace, "node_modules"),
    path.join(workspace, "packages", "app", "node_modules"),
  ];
  for (const link of links) await fs.symlink(shared, link, "junction");
  Object.defineProperty(process, "platform", { value: "win32" });
  await unlinkWorktreeLinks(workspace);
  for (const link of links) await expect(fs.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(shared, "keep.txt"), "utf-8")).toBe("shared dependency");
});
