# Execution deployment and ownership

`OPENSPRINT_DEPLOYMENT_MODE` chooses `trusted-local` (default), `shared-host`, or `isolated-hosted`. The first two execute trusted project code with the backend user's permissions. `isolated-hosted` requires a Linux Docker daemon and fails closed if its image, command, resource limits, or network boundary are unavailable. It never falls back to host execution. Multiple backend replicas require PostgreSQL and isolated execution; SQLite is a single-backend deployment.

The SQL project catalog is authoritative across replicas; each host's legacy `~/.opensprint/projects.json` is imported once. Deletion tombstones prevent another host's stale file from resurrecting a project. Project lists read the SQL catalog and settings on each request. Canonical repositories and prepared task worktrees must still be on shared storage mounted at identical absolute paths on every replica; Docker must run on the backend's host with access to that backend's private staging directory. Backend HOME directories do not need to be shared. Global host/provider configuration is administrator-managed and must be consistent across replicas.

## Isolated worker configuration

Set these administrator-owned environment variables before starting the backend:

```text
OPENSPRINT_DEPLOYMENT_MODE=isolated-hosted
OPENSPRINT_ISOLATED_IMAGE=your-registry/opensprint-worker@sha256:<64 hexadecimal characters>
OPENSPRINT_ISOLATED_COMMAND=["/usr/local/bin/opensprint-worker"]
```

The image must contain the project toolchain, its agent implementation, and any dependency cache needed for offline builds. The command is an argv array, not a backend shell command. It runs in `/workspace` in a disposable independent Git clone. `OPENSPRINT_PROMPT_PATH` identifies this attempt's prompt. The worker reads that prompt, commits its candidate to `refs/heads/submission`, writes its structured `result.json` beside the prompt, and creates exactly one advertised bundle head:

```sh
git bundle create /workspace/worker.bundle refs/heads/submission
```

The submitted commit must descend from its assigned base without merge commits. The trusted publisher independently validates the bundle, task scope, destination branch, current fence, and quality gates before updating the prepared task branch by compare-and-swap. The worker receives no canonical repository mount, backend HOME, database URL, OAuth store, provider keys, Docker socket, or backend access token. Git metadata in the worker clone cannot configure the trusted publisher. Artifacts and results have size and regular-file checks; worker results cannot traverse symlinks outside the private workspace.

The root filesystem is read-only; the worker has a disposable workspace and bounded `/tmp`, no capabilities, no privilege escalation, a private IPC namespace, and no published ports. Defaults and supported bounds are:

| Environment variable               | Default  | Allowed range  |
| ---------------------------------- | -------- | -------------- |
| `OPENSPRINT_ISOLATED_CPUS`         | 1        | 0.1–8          |
| `OPENSPRINT_ISOLATED_MEMORY_MB`    | 1024     | 64–8192        |
| `OPENSPRINT_ISOLATED_PIDS`         | 128      | 8–512          |
| `OPENSPRINT_ISOLATED_TIMEOUT_MS`   | 1800000  | 1000–7200000   |
| `OPENSPRINT_ISOLATED_OUTPUT_BYTES` | 10485760 | 1024–104857600 |

Networking defaults to `none`. An administrator may configure `OPENSPRINT_ISOLATED_NETWORK=opensprint-isolated-<name>` only for a Docker **internal** network. The backend checks that property before every worker or gate. Such a network may contain an administrator-operated model or dependency proxy; workers receive no general backend credential. Host/public Docker networks are rejected. Images that need unrestricted internet or interactive host CLI authentication are unsuitable for this mode.

Repository quality gates and scoped tests use the same Docker boundary and a fresh private snapshot. The gate image must supply build dependencies or an offline package cache. Host API file/shell tools and host CLI planning are disabled in isolated mode. Planning can use API providers without host tools. Development servers, local tooling installation, and local editor/scaffolding routes require the trusted modes. Deployment commands use the isolated command boundary where supported. Explicit deployment credentials are supplied through a private environment file outside the mounted workspace; ambient backend credentials are never copied. Docker/Git/PATH/HOME isolation controls cannot be overridden. Cancellation and time limits remove a previously created container identity and await Docker acknowledgement. A lost daemon or unobserved exit leaves the attempt uncertain and preserves its private staging directory for operator reconciliation.

Docker flags follow [Docker's container run reference](https://docs.docker.com/reference/cli/docker/container/run/) and [resource constraint documentation](https://docs.docker.com/engine/containers/resource_constraints/). The Docker daemon and image administrator remain trusted control-plane components.

## Fences, cancellation, and recovery

Each backend has a random owner identity. PostgreSQL replicas contend on project-leader and attempt rows using atomic SQL compare-and-swap, monotonically increasing generations, and database-clock lease expiry. Attempts become durable while queued, before FIFO admission. Heartbeats renew every 10 seconds with a 45-second lease; launch revalidates ownership after admission and immediately before invocation. Attempt fences also bind the project leader's generation. A stale owner cannot append accepted output, publish artifacts, or perform task-store transitions from its result callback.

A stop request persists as `stop_requested`. Process/container exit must be observed before `stopped` or destructive worktree cleanup. Closing a browser or conversation does not cancel a run. A recovered PID proves only possible liveness: unverified recovered execution remains `uncertain`, retains its assignment/worktree, and cannot be signalled or automatically requeued. Independent process ownership verification is required before a later controller may take over such a process.

## Output replay and verification

The runtime API exposes current attempt observations and durable per-attempt UTF-8 byte offsets:

```text
GET /api/v1/projects/:id/runtime/attempts?taskId=:taskId
GET /api/v1/projects/:id/runtime/attempts/:attemptId/output?offset=:nextOffset
```

Use the returned `nextOffset` for reconnects. HTTP 410 explicitly reports an expired offset and the earliest retained `startOffset`; HTTP 404 reports an unknown/retired attempt. Each attempt retains at most 5 MiB in SQL, with complete UTF-8 chunks. Completed history is limited to the latest 100 streams per project and 24 hours; active/uncertain attempts remain protected. Earlier-attempt chunks fail their generation check instead of contaminating the current stream.

The SQLite ownership/output suite exercises concurrent claim, takeover, stale results, project leadership changes, stop state, and retained offsets against real SQLite. Controlled process-boundary tests exercise private mounts, missing Docker, network rejection, and observed stop. `isolated-runner.test.ts` also includes real Docker smoke tests: local runs skip them only when a Linux Docker daemon is unavailable. The CI test and merge-gate jobs require Linux Docker, preload the image digest, and fail if Docker acceptance would be skipped. On a Docker-enabled runner it pulls `busybox:1.37` and uses its immutable digest, or uses the digest supplied by `OPENSPRINT_DOCKER_SMOKE_IMAGE`, then verifies the read-only root, scoped environment, resource controls, disposable gate workspace, and observed cancellation of an actually running container.
