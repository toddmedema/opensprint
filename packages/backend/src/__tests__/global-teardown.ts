/**
 * Vitest global teardown: remove generated test URL file.
 * Native Postgres is not started by us, so there is no container to stop.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_FILE = path.resolve(__dirname, "../../.vitest-postgres-url");

export default async function globalTeardown() {
  await fs.unlink(URL_FILE).catch(() => {});
}
