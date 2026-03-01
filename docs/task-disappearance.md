# Why tasks can disappear from the PostgreSQL database

Tasks are **removed from the database** (hard delete) only in these cases:

## 1. Project deletion

- **When:** You delete a project (e.g. DELETE `/projects/:id` or equivalent in the UI).
- **What:** `TaskStoreService.deleteByProjectId(projectId)` runs and deletes **all** tasks (and feedback, plans, sessions, etc.) for that project.
- **Code:** `ProjectService.deleteProject()` → `taskStore.deleteByProjectId(id)`.

## 2. Feedback cancellation

- **When:** A feedback item is cancelled (e.g. POST `/projects/:projectId/feedback/:feedbackId/cancel`).
- **What:** The feedback status is set to `cancelled`, then **all tasks linked to that feedback are deleted**: `createdTaskIds` and `feedbackSourceTaskId`.
- **Code:** `FeedbackService.cancelFeedback()` → `taskStore.deleteMany(projectId, taskIdsToDelete)`.

## 3. Plan deletion

- **When:** A plan is deleted (e.g. DELETE `/projects/:projectId/plans/:planId`).
- **What:** The plan’s epic and **all child tasks** (IDs starting with `epicId.`) are deleted, then the plan row is removed.
- **Code:** `PlanService.deletePlan()` → for each child task `taskStore.delete(projectId, id)` → `taskStore.planDelete()`.

## 4. Plan rebuild (reship) when no tasks have started

- **When:** You trigger “Rebuild” on a plan and **every child task is still `open`** (none in progress or done).
- **What:** All existing child tasks for that epic are **deleted**, then `shipPlan()` is called and **new** tasks are created (with new IDs). So the old task rows are gone.
- **Code:** `PlanService.reshipPlan()` → when `noneStarted && children.length > 0`, loop `taskStore.delete(projectId, child.id)` → `shipPlan()`.

If you use “Rebuild” before starting any work, this is a common cause of “my tasks disappeared”: the old tasks are intentionally replaced by a fresh set.

---

## What does *not* delete tasks

- **Closing a task** (`taskStore.close()`) only sets `status = 'closed'` and `close_reason` / `completed_at`. The row stays in the database; closed tasks still appear in `listAll` and in the API.
- **Archiving a plan** only closes (updates status of) ready/open tasks; it does not delete them.
- **Schema init** (`runSchema`) uses `CREATE TABLE IF NOT EXISTS` and does not drop or truncate tables, so it does not wipe data.
- **Database URL:** The task store uses a single Postgres URL from `~/.opensprint/global-settings.json` (`databaseUrl`) or the default. If you point at a different database (e.g. another environment or a new DB), you’ll see different data there; nothing in the code deletes tasks when switching URL.
- **Stale-slot reconciliation:** When the orchestrator or recovery service checks whether slotted tasks still exist, they call `listAll(projectId)`. If that returns **no tasks** while there are active slots, we **skip** removing those slots (we do not kill agents). We only remove a slot when the task is missing from a **non-empty** task list (e.g. task was archived). This avoids killing agents when `listAll` returns empty due to a wrong DB, transient error, or another process having wiped the DB.

---

## Tests and the app database

Backend tests that use a real Postgres DB must **never** use the app database (`opensprint` on localhost:5432), or test setup (e.g. `DELETE FROM tasks`) would wipe live data. The test helper (`packages/backend/src/__tests__/test-db-helper.ts`) enforces this:

- **Fallback:** When `TEST_DATABASE_URL` is unset and `.vitest-postgres-url` is missing, tests use `opensprint_test`.
- **Rewrite:** For any URL pointing at localhost:5432 with database `opensprint`, the URL is rewritten to use `opensprint_test`.
- **Runtime check:** After connecting, tests run `SELECT current_database()`; if it is `opensprint`, they throw `TestDatabaseRefusedError` instead of proceeding.

Create the test DB for local runs: `createdb opensprint_test`. When tests run, you should see `[test-db-helper] Tests using database: opensprint_test` in the test output.

---

## 5. App using the test database (opensprint_test)

- **When:** The app is configured to use the **test** database (`opensprint_test`), e.g. via `databaseUrl` in `~/.opensprint/global-settings.json` or **`DATABASE_URL`** (e.g. in `.env`). You then run backend tests (e.g. `npm test` in another terminal). Test setup runs `DELETE FROM tasks` (and task_dependencies, plans, etc.) against the same DB the app is using, so all tasks disappear shortly after tests run.
- **Fix:** Use the **app** database for the app (default `opensprint`) and the **test** database only for tests. Ensure neither `databaseUrl` in `~/.opensprint/global-settings.json` nor `DATABASE_URL` in the environment points at `opensprint_test` when running the app.
- **Guard:** The backend resolves the URL via `getDatabaseUrl()` (env then file then default), then refuses to start if the database name is `opensprint_test` and exits with a clear error. At startup it logs `Using database` with the resolved name so you can confirm the app is on `opensprint`.
- **If the trace file only shows `database=opensprint_test`:** Those lines are from **test runs** (tests use `opensprint_test`). If the app were using `opensprint_test`, the guard would normally prevent startup; if the app still started, check for `DATABASE_URL` in `.env` or your shell and `databaseUrl` in `~/.opensprint/global-settings.json` and fix any that point at `opensprint_test`.

---

## If tasks keep disappearing

1. **Check which of the five cases applies:** project delete, feedback cancel, plan delete, plan rebuild with no started tasks, or app using test DB (above).
2. **Confirm you’re on the same database:** Ensure `databaseUrl` in `~/.opensprint/global-settings.json` (or the default) is the same for every run; otherwise you may be looking at different DBs.
3. **If it happens when a coding agent is running:** Check the persistent trace file `~/.opensprint/task-delete-trace.log` after reproduction — each line includes `pid=`, timestamp, method, projectId, and database name. Compare `pid` to your backend process (e.g. from `ps` or startup logs): if the pid in the trace matches your backend, that process is the deleter; if there are no trace lines or the pid differs, **another process** (e.g. tests, or a second backend) is deleting. Ensure only one backend is running and that tests use `opensprint_test` only, never the app database.
4. **If it happens when running tests:** Ensure `createdb opensprint_test` has been run and that test output shows `Tests using database: opensprint_test`. Never point the **app** at `opensprint_test`; the app will refuse to start. Do not set `TEST_DATABASE_URL` to the app database (e.g. a remote prod URL ending in `/opensprint`); tests refuse that and throw `TestDatabaseRefusedError`. If you see `TestDatabaseRefusedError`, the test run attempted to use the app DB and was correctly refused.
5. **Add logging:** Add logs at the four code paths above (e.g. in `deleteByProjectId`, `deleteMany`, `delete` in plan delete, and the delete loop in `reshipPlan`) with `projectId` and task IDs so you can see exactly when and why tasks are removed.

---

## PostgreSQL-level audit (who deleted tasks)

A **trigger** on the `tasks` table writes one row into **`task_delete_audit`** for every `DELETE`. This catches every delete regardless of which process or connection did it.

- **Columns:** `deleted_at`, `project_id`, `task_id`, `pg_backend_pid`, `application_name`, `usename`, `client_addr`
- The app sets **`application_name=opensprint-app`** on its connections. Test runners typically leave it unset or use something else. So you can tell app vs. other clients from `application_name`.

**After tasks disappear, query the audit table:**

```sql
SELECT * FROM task_delete_audit ORDER BY deleted_at DESC LIMIT 100;
```

- **`application_name = 'opensprint-app'`** → delete came from the **web app** (main backend). Restart the backend so all connections use this tag.
- **`application_name = 'opensprint-test'`** → delete came from the **test runner** (vitest). If these rows are in the **opensprint** DB, tests are running against the app database; stop running tests while the app is in use, or fix test config so tests use `opensprint_test` only.
- **`application_name` NULL** → connection didn’t set a name (e.g. app not restarted after the tag was added, or an older client). Restart the backend so new connections get `opensprint-app`; then reproduce and check the audit again.

If you see **project_id** values like `plan-complexity-test-project`, `test-project`, `proj-delete-test`, or `proj-keep` in the **opensprint** database audit, **tests are running against the app database** and wiping data. Fix it as follows:

1. **Do not run tests while the app is running** with real data (e.g. stop `npm run dev` before running `npm test`, or disable IDE “run tests on save” when using the app).
2. **Ensure tests use the test database only:** When you run `npm test`, the first DB-using test should log `[test-db-helper] Tests using database: opensprint_test`. If you do not see that line or see `opensprint`, then `TEST_DATABASE_URL` or `.vitest-postgres-url` is pointing at the app DB. Unset `TEST_DATABASE_URL` in your environment (and in any `.env` that the test runner loads) so that global-setup’s file is used, or set `TEST_DATABASE_URL` explicitly to `postgresql://opensprint:opensprint@localhost:5432/opensprint_test`.
3. **Never set `TEST_DATABASE_URL`** to a URL whose database name is `opensprint` (the app DB); the test helper refuses that and throws `TestDatabaseRefusedError`.

**Optional: log all statements in PostgreSQL**

To see the exact SQL that ran (e.g. `DELETE FROM tasks WHERE ...`), enable statement logging on the server (requires access to Postgres config or superuser):

- **Temporary (current session):** `SET log_statement = 'all';` (superuser)
- **For all connections:** In `postgresql.conf`, set `log_statement = 'all'` (or `'ddl'` / `'mod'` to reduce noise), then reload. Check the Postgres log file (e.g. `pg_log/`) for the DELETE statements and the connection/backend PID that ran them.
