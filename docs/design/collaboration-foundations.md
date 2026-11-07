# Collaboration and execution ownership

The product remains a modular monolith with one trusted backend. Projects, the default shared session, ordinary conversations and individual execution attempts have separate identities and lifetimes. Closing a browser does not own or cancel execution.

## Using the shared session

Selecting a task in Execute opens one shared workspace. **Work** embeds the existing task inspector and preserves its task actions; **Discussion** contains the shared conversation and a bottom composer. The selected task comes from the board, with no second task navigator. The standalone `/collaborate/<projectId>` view uses the same compact layout with a task picker in its title and a scoped Work view. Local installation sessions join automatically; invited browsers use their own project credentials. Credentials stay in memory and are cleared when leaving or changing projects; they are never persisted in browser storage or query-cache keys.

The local host uses one **Share** sheet to create a named credential. Discussion permission and a 24-hour expiry are defaults; **Can view**, **Can discuss**, **Can guide agents**, and other expiry choices remain available secondarily. Manage access lists invitations and supports revocation. The generated link carries the secret in its fragment; the join page removes that fragment immediately and retains the credential in memory. The server stores only its SHA-256 hash. The raw secret is returned once, when the invitation is created. Expiration and revocation are checked on subsequent authenticated requests. Collaboration credentials cannot create or revoke invitations.

An invitation uses the configured guest origin when sharing is enabled, otherwise the application's current origin. A loopback address is usable on that machine. Invitation creation does not configure public hosting or expose the installation.

### Remote sharing

The desktop server supplies a privileged local-session bootstrap. **Do not expose or reverse proxy the desktop server to guests.** For remote participants, enable the separate collaboration-only listener:

```sh
OPENSPRINT_COLLABORATION_PORT=3190 \
OPENSPRINT_COLLABORATION_ORIGIN=https://collaborate.example.com \
npm run start -w packages/backend
```

Build the application first. Packaged installations use `OPENSPRINT_FRONTEND_DIST`; a repository build uses `packages/frontend/dist`. The new listener binds only to `127.0.0.1` on its separate port. Configure your HTTPS reverse proxy to forward the guest origin exclusively to port **3190**, keeping the installation's regular API/desktop port private. Both environment variables are required. A public origin must use HTTPS; HTTP is accepted only on loopback for local testing. Restart the backend after changing this configuration.

The guest listener serves the built frontend without a host credential, admits the configured public origin, and mounts only project collaboration APIs. The existing host bearer is accepted on either listener for host clients, but is never served by the guest listener and must not be shared with invitees. Host settings, filesystem, deployment, governance and session-bootstrap routes are unavailable there. The host's Invite form uses this guest origin automatically. Disabling sharing leaves the ordinary local installation unchanged. TLS termination, DNS and access to the reverse proxy remain deployment responsibilities.

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

Pages served by the guest listener use its same-origin collaboration API, even when the frontend bundle was built with a private host API base. Host pages and independently hosted frontends retain their configured API base. The guest bootstrap changes routing only and grants no authority.

Deleting a project atomically clears its collaboration contents and credentials. A durable lifecycle marker retains only the project ID and deletion timestamp, so already admitted requests cannot recreate deleted state. Every collaboration writer checks that marker under the same database lock; retries remain safe even if later project cleanup fails.

The selected task exposes bounded output, diff and guidance history. Shared diffs include supported text patches from committed, staged and tracked working changes. Binary patches and paths containing spaces are omitted. New-file contents appear after staging or committing; shared previews do not reopen untracked checkout paths. Output comes from managed in-memory run state or archived sessions; the guest projection never falls back to mutable checkout output-log paths or shares recovered output tailed from those files. Known credential patterns are redacted across aggregated events before the display tail is limited. A retained tail with an unknown start omits its incomplete leading record. Completed diff reads may be reused for up to three seconds for the same verified project, attempt, checkout and comparison settings; output and checkout/attempt validation remain fresh on each request. Read paths validate task membership in the project, and live context is checked against its execution attempt before it is returned. Completed tasks retain their latest archived context. File and diff references are discussion metadata and never authorize arbitrary filesystem reads.

Claim control before sending guidance. The current controller can release the run or offer control to another authorized person. A collaborator can request control from its current controller. The recipient accepts or declines the pending request; its sender can cancel it. Each transition checks the current control revision. Every HTTP control command also requires a task ID and validation against that task's current attempt; taskless internal compatibility commands are not exposed to invited clients. The controller remains unchanged until acceptance or explicit release. Presence expiry does not release control. Compatibility permits local guidance for an attempt with no collaboration control record. Once explicit control exists, an unclaimed run requires a new claim.

Discussion does not automatically enter a model request. A message action prepares an editable instruction with its author and contextual reference; **Guide agent** opens a focused sheet where the user explicitly submits to the selected attempt. Compact ownership and contextual requests replace the permanent handoff panel. Instruction receipts appear with discussion; detailed provenance and older-attempt drafts remain secondary. A retry never silently consumes guidance prepared for another attempt.

## Presence and catching up

Each browser sends an authenticated presence heartbeat with its selected task. Presence expires when heartbeats stop; it is separate from durable execution ownership. Avatars open a people sheet. Live participant-following is omitted from this interface.

Per-actor project preferences store task subscriptions and a monotonically advancing seen cursor. Discussion opens at the latest messages, follows new updates only while the reader is at the bottom, and offers a contextual jump back to the latest message. Loading earlier history preserves the visible reading position. Unread markers, relevant notifications, and earlier messages replace a separate Activity destination. Only a contiguous actually displayed event prefix can advance the cursor; polling, opening Work, or fetching unseen pages does not acknowledge unread activity. Cursor-only preference updates preserve subscriptions atomically; viewing a message cannot overwrite notification choices changed in another tab. Task notification preferences are secondary. Durable events and APIs retain attributed discussion, decisions, control transitions, and work context for recovery and inspection.

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
| Separate sessions, conversations and attempts | Default project session, named invitations and roles, attributed discussion, consent-based control handoff, expiring presence                                                                           | Typing indicators, live participant-following, and account-based login administration                                                  |
| Durable command/message acceptance            | Immutable command identities, conversation message merge, durable attempt guidance, command execution reservation                                                                                       | Server-owned operation recovery for every planning/deployment action; transactional SQL guidance outbox                                |
| Shared transaction boundary and revisions     | AppDb ownership, consistent snapshots, session/control/draft CAS, optional section revision, single-winner decisions; atomic raw settings transforms preserve background updates and inherited defaults | Task/plan revision checks across all writers, the rest of the Query ownership migration, and cross-process settings coordination       |
| Resumable realtime                            | Durable commit-ordered session event replay, coherent cursor, bounded snapshot, gap recovery and transport budgets                                                                                      | Full task/approval semantic outbox, retained-log run offsets, retention/compaction policy                                              |
| Runner boundary and ownership                 | Local runner adapter, cancellable admission, stable accounting, generation checks, conservative recovery                                                                                                | Database-fenced multi-process run owners and isolated process ownership verification                                                   |
| Draft/published separation                    | Reviewed SPEC workflow, immutable revisions, bound approval, candidate gates, effect reconciliation                                                                                                     | Migrate legacy autosaves/publication and approval continuations to this protocol; durable deployment publication operations            |
| Explicit execution deployment modes           | Trusted local pilot, scoped project credentials, trusted host-only publication                                                                                                                          | Isolated remote runners, scoped execution credentials/resource budgets, immutable remote artifact intake and multiple backend replicas |

These remaining items are not claimed as implemented. Full shared-host product support requires the rest of the authorization/revision/outbox rollout. Mutually untrusted repository hosting and multiple backend replicas remain outside the pilot. Microservices, a broker, universal event sourcing and CRDT editing remain deferred as recommended by the source review.
