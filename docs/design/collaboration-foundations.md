# Collaboration and execution ownership

The product remains a modular monolith with one trusted backend. Projects, the default shared session, ordinary conversations and individual execution attempts have separate identities and lifetimes. Closing a browser does not own or cancel execution.

## Using the shared session

Open **Collaborate** in Execute to work alongside the selected task, or `/collaborate/<projectId>` for the standalone view. The task picker uses project task titles. A local installation session joins automatically. Each invited browser joins with its own project credential. Credentials stay in memory and are cleared when leaving or changing projects; they are never persisted in browser storage or query-cache keys.

The local host uses **Invite** to create a named credential with **Can view**, **Can discuss**, or **Can guide agents** permission and an expiration. The generated link carries the secret in its fragment; the join page removes that fragment immediately and retains the credential in memory. The server stores only its SHA-256 hash. The raw secret is returned once, when the invite is created. The host can list invitations and revoke them. Expiration and revocation are checked on subsequent authenticated requests. Collaboration credentials cannot create or revoke invitations.

An invitation uses the configured guest origin when sharing is enabled, otherwise the application's current origin. A loopback address is usable on that machine. Invitation creation does not configure public hosting or expose the installation.

### Remote sharing

The desktop server supplies a privileged local-session bootstrap. **Do not expose or reverse proxy the desktop server to guests.** For remote participants, enable the separate collaboration-only listener:

```sh
OPENSPRINT_COLLABORATION_PORT=3190 \
OPENSPRINT_COLLABORATION_ORIGIN=https://collaborate.example.com \
npm run start -w packages/backend
```

Build the application first. Packaged installations use `OPENSPRINT_FRONTEND_DIST`; a repository build uses `packages/frontend/dist`. The new listener binds only to `127.0.0.1` on its separate port. Configure your HTTPS reverse proxy to forward the guest origin exclusively to port **3190**, keeping the installation's regular API/desktop port private. Both environment variables are required. A public origin must use HTTPS; HTTP is accepted only on loopback for local testing. Restart the backend after changing this configuration.

The guest listener serves the built frontend without a host credential, admits the configured public origin, and mounts only project collaboration APIs. Host settings, filesystem, deployment, governance and session-bootstrap routes are unavailable there. The host's Invite form uses this guest origin automatically. Disabling sharing leaves the ordinary local installation unchanged. TLS termination, DNS and access to the reverse proxy remain deployment responsibilities.

For existing deployments, the host may also configure `OPENSPRINT_COLLABORATION_TOKENS` as a JSON array:

```json
[
  {
    "tokenHash": "<SHA-256 hex digest of a high-entropy bearer token>",
    "actorId": "alice",
    "displayName": "Alice",
    "projects": { "project-id": "controller" }
  }
]
```

Generate a random token, distribute it privately, and configure only its hash. Restart the backend after changing credentials. Actor IDs and token hashes must be unique. Roles are `viewer` (read), `participant` (read and discuss), and `controller` (also claim/handoff a run and send guidance). Client-supplied names and actor IDs never establish authority. Handoff targets must already have controller permission for that project. Local installation credentials remain privileged host credentials and must not be distributed to participants.

The selected task exposes bounded output, diff and guidance history. Read paths validate task membership in the project, and live context is checked against its execution attempt before it is returned. Completed tasks retain their latest archived context. File and diff references are discussion metadata and never authorize arbitrary filesystem reads.

Claim control before sending guidance. The current controller can release the run or offer control to another authorized person. A collaborator can request control from its current controller. The recipient accepts or declines the pending request; its sender can cancel it. Each transition checks the current control revision. The controller remains unchanged until acceptance or explicit release. Presence expiry does not release control. Compatibility permits local guidance for an attempt with no collaboration control record. Once explicit control exists, an unclaimed run requires a new claim.

Discussion does not automatically enter a model request. **Use as agent guidance** prepares an editable instruction with its author and contextual reference; the user explicitly submits it to the selected attempt. The guidance history shows durable dispositions even after that attempt ends. A retry never silently consumes guidance prepared for another attempt.

## Presence and catching up

Each browser sends an authenticated presence heartbeat with its selected task. Presence expires when heartbeats stop; it is separate from durable execution ownership. Following a participant tracks their task selection until the follower stops following or selects another task.

Per-actor project preferences store task subscriptions and a monotonically advancing seen cursor. Marking activity read records a server timestamp for task catch-up. Activity includes attributed discussion, decisions and control transitions. Task completion timestamps, execution summaries and unresolved questions provide work context. Notifications are derived from durable events for mentions, control requests and subscribed task discussion. Polling or opening the panel does not automatically acknowledge unread activity.

Collaboration endpoints resolve project membership before returning state. Named credentials cannot access the existing local-only settings, filesystem, deployment, integration or publication APIs. The optional guest listener admits only its explicitly configured origin; it does not add TLS termination or login management.

## Committed state and replay

`GET /api/v1/projects/:projectId/collaboration/snapshot` returns a consistent snapshot and cursor. `GET .../events?after=<cursor>&limit=200` returns subsequent committed events. A future/invalid cursor requires a new snapshot. The UI polls this durable stream and recovers gaps using a snapshot; page visibility and network loss do not drop committed discussion/control events.

Commands reserve a project/actor/request identity with the normalized payload in the same transaction as the resulting state and semantic event. Reuse with different content conflicts. A project row serializes stream counter increments with commit order. SQLite serialization is owned by AppDb, shared by TaskStore and new repositories. PostgreSQL snapshots use a repeatable-read read-only transaction. Snapshot message/run lists are bounded; earlier records remain in the durable replay stream. There is currently no event-retention pruning.

Server state for the new session is owned by React Query. Existing product slices retain their current migration state. Ordinary conversations append each operation's additions under the persisted row lock so overlapping model requests cannot replace another request's transcript. Their legacy transcript arrays do not yet provide request-level deduplication.

## Agent guidance and execution

Guidance uses a project/task-scoped, fsynced append journal in the writable user-data directory `~/.opensprint/guidance`, outside active-task cleanup and installed application resources. Each instruction records its server message ID, client message ID, actor and exact attempt ID. An uncertain network retry reuses its identity. A definite rejection or a new user submission gets a new identity.

`accepted` and `queued` record durable local intent; `included` records addition to a provider request. None proves that a model obeyed the instruction. `failed` and `run-ended` preserve rejected or unconsumed instructions. Queue closure, max-turn termination and service restart cannot silently transfer guidance to a different attempt. OpenAI, Anthropic and Google between-turn payloads retain guidance alongside tool results. CLI backends keep their unsupported state. Unscoped legacy JSONL files remain on disk because their project cannot be safely inferred.

The local runner boundary exposes start, observe, steer and cancel. FIFO admission accepts cancellation; mutable limits preserve all running permits, including transitions from unlimited operation. Attempt generations, cancelled tombstones and exact owning-slot checks prevent obsolete work from starting or completing a replacement attempt. Recovery inspects fresh assignments without removing their destructive-cleanup protection. A persisted PID is insufficient evidence of ownership. Unverified recovered processes remain observed, accounted for and explicitly uncertain; the backend does not signal or requeue them. Stop requested and observed completion remain distinct states.

WebSocket outbound queues and events are bounded at 8 MiB per connection/event. Slow clients reconnect and recover authoritative state; output backfills are bounded snapshots. Semantic collaboration replay is durable; existing task/output events continue using the existing refetch/backfill protocol.

## Drafts, approval and Git publication

`/projects/<projectId>/publication` provides a reviewed publishing workflow for the trusted host. It uses `/api/v1/projects/:projectId/publication/{draft,approve,publish,operations/:operationId}`. Immutable SQL drafts reference a content hash, base SHA and destination branch. Saving requires the expected draft revision. Approval binds the exact current revision. Publication reserves an operation before preparing an isolated candidate; configured merge gates run against that candidate. Changes made by validation invalidate the candidate. Git advances only with the recorded expected base. The publisher changes only SPEC and preserves unrelated unstaged editor work; staged changes require resolution first.

The prepared commit is recorded before branch advancement. Reconciliation checks commit ancestry, exact approved bytes, current HEAD, index and working content. It never overwrites manual changes or blindly repeats an interrupted effect. Interrupted or contradictory evidence remains `uncertain`. Metadata and the published document snapshot finalize together with the operation state.

This workflow is opt-in. Existing Sketch/model autosaves keep the trusted local editing policy and legacy Git queue. They are serialized across PrdService instances, and the section API accepts an expected version for conflict detection, but they are not universally routed through reviewed drafts or publication gates. The new page states that distinction. Concurrent notification resolution and command execution now have atomic acceptance checks; interrupted command effects remain discoverable as executing instead of being blindly rerun.

## Recommendation disposition and further rollout

| Review recommendation                         | Implemented here                                                                                                                                                                                        | Remaining rollout                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Separate sessions, conversations and attempts | Default project session, named invitations and roles, attributed discussion, consent-based control handoff, expiring presence, participant following                                                    | Typing indicators and account-based login administration                                                                               |
| Durable command/message acceptance            | Immutable command identities, conversation message merge, durable attempt guidance, command execution reservation                                                                                       | Server-owned operation recovery for every planning/deployment action; transactional SQL guidance outbox                                |
| Shared transaction boundary and revisions     | AppDb ownership, consistent snapshots, session/control/draft CAS, optional section revision, single-winner decisions; atomic raw settings transforms preserve background updates and inherited defaults | Task/plan revision checks across all writers, the rest of the Query ownership migration, and cross-process settings coordination       |
| Resumable realtime                            | Durable commit-ordered session event replay, coherent cursor, bounded snapshot, gap recovery and transport budgets                                                                                      | Full task/approval semantic outbox, retained-log run offsets, retention/compaction policy                                              |
| Runner boundary and ownership                 | Local runner adapter, cancellable admission, stable accounting, generation checks, conservative recovery                                                                                                | Database-fenced multi-process run owners and isolated process ownership verification                                                   |
| Draft/published separation                    | Reviewed SPEC workflow, immutable revisions, bound approval, candidate gates, effect reconciliation                                                                                                     | Migrate legacy autosaves/publication and approval continuations to this protocol; durable deployment publication operations            |
| Explicit execution deployment modes           | Trusted local pilot, scoped project credentials, trusted host-only publication                                                                                                                          | Isolated remote runners, scoped execution credentials/resource budgets, immutable remote artifact intake and multiple backend replicas |

These remaining items are not claimed as implemented. Full shared-host product support requires the rest of the authorization/revision/outbox rollout. Mutually untrusted repository hosting and multiple backend replicas remain outside the pilot. Microservices, a broker, universal event sourcing and CRDT editing remain deferred as recommended by the source review.
