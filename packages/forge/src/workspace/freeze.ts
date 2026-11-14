import fs from "node:fs";
import path from "node:path";

export function setTreeWritable(root: string, writable: boolean): void {
  if (!fs.existsSync(root)) return;
  if (writable) {
    try {
      fs.chmodSync(root, 0o755);
    } catch {
      // The directory may already be writable.
    }
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) setTreeWritable(full, writable);
    else {
      try {
        fs.chmodSync(full, writable ? 0o644 : 0o444);
      } catch {
        // Leave unreadable files alone.
      }
    }
  }
  if (!writable) {
    try {
      fs.chmodSync(root, 0o555);
    } catch {
      // A frozen directory is still usable for reads.
    }
  }
}
