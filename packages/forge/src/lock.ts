import fs from "node:fs";
import path from "node:path";

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireProcessLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "server.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return () => releaseProcessLock(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (pidAlive(current)) {
        throw new Error(
          `Another Open Sprint server already holds ${dataDir} (pid ${current}). Refusing to start.`
        );
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Could not acquire the server lock at ${lockPath}.`);
}

function releaseProcessLock(lockPath: string): void {
  try {
    const current = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (current === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {
    // The lock file is already gone.
  }
}

export function writeDurable(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
