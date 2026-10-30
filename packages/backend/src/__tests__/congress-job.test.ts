import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { claimCongressDraft, finishCongressDraft } from "../services/congress-job.js";
describe("durable Congress drafting jobs", () => {
  let native: Database.Database;
  let db: ReturnType<typeof createSqliteDbClient>;
  beforeEach(async () => {
    native = new Database(":memory:");
    db = createSqliteDbClient(native);
    await db.execute(
      "CREATE TABLE governance_jobs(project_id TEXT,id TEXT,kind TEXT,state TEXT,payload TEXT,PRIMARY KEY(project_id,id))"
    );
  });
  afterEach(() => {
    native.close();
  });
  it("reclaims crashed jobs after the lease expires and bounds total attempts", async () => {
    const first = await claimCongressDraft(db, "p", "n1", 0);
    expect(first?.attempts).toBe(1);
    expect(await claimCongressDraft(db, "p", "n1", 1)).toBeNull();
    const recovered = await claimCongressDraft(db, "p", "n1", 600_001);
    expect(recovered?.attempts).toBe(2);
    const third = await claimCongressDraft(db, "p", "n1", 1_200_002);
    expect(third?.attempts).toBe(3);
    expect(await claimCongressDraft(db, "p", "n1", 1_800_003)).toBeNull();
    // Another nomination remains runnable after exhausted failures.
    expect((await claimCongressDraft(db, "p", "n2", 1_800_003))?.attempts).toBe(1);
  });
  it("ignores a late worker completion after another worker reclaims its lease", async () => {
    const first = (await claimCongressDraft(db, "p", "n1", 0))!;
    const recovered = (await claimCongressDraft(db, "p", "n1", 600_001))!;
    await finishCongressDraft(db, "p", first);
    const running = await db.queryOne(
      "SELECT state,payload FROM governance_jobs WHERE project_id='p' AND id='draft-n1'"
    );
    expect(running?.state).toBe("running");
    expect(JSON.parse(String(running?.payload)).token).toBe(recovered.token);
    await finishCongressDraft(db, "p", recovered);
    expect(await claimCongressDraft(db, "p", "n1", 1_200_002)).toBeNull();
  });
});
