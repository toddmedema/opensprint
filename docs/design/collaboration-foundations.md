# Collaboration and execution ownership

This implements the first collaboration foundation from the first-principles review in thread `01a15b66-fc06-7882-9cf2-f85c3ed9a119`. The product remains a modular monolith with one trusted backend. Projects, the default shared session, ordinary conversations and individual execution attempts have separate identities and lifetimes. Closing a browser does not own or cancel execution.

## Using the shared session

Open `/collaborate/<projectId>` or the **Open shared session** link in Execute. Each browser joins with its own project credential. Leave the credential blank to use the existing local installation session. The credential stays in memory and is cleared when leaving or changing projects; it is never included in URLs or persisted in browser storage.

The host configures `OPENSPRINT_COLLABORATION_TOKENS` as a JSON array:

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

Enter the active task ID to inspect its current attempt and control revision. Claim control before sending guidance; handing over or releasing control revokes the previous owner. Compatibility permits local guidance for an attempt with no collaboration control record. Once explicit control exists, an unclaimed run requires a new claim. Discussion does not automatically enter a model request. The separate guidance form shows the durable dispositions of instructions, including after the active attempt ends.

Collaboration endpoints resolve project membership before returning state. Named credentials cannot access the existing local-only settings, filesystem, deployment, integration or publication APIs. The pilot does not add remote network listeners, cross-origin allowances, TLS termination or login management. Serve the existing application through an appropriately configured trusted host when testing browsers on other machines.

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
| Separate sessions, conversations and attempts | Default project session, named actor roles, attributed discussion, control handoff, independent navigation                                                                                              | Presence/typing expiry, optional presenter following, invitation/login administration                                                  |
| Durable command/message acceptance            | Immutable command identities, conversation message merge, durable attempt guidance, command execution reservation                                                                                       | Server-owned operation recovery for every planning/deployment action; transactional SQL guidance outbox                                |
| Shared transaction boundary and revisions     | AppDb ownership, consistent snapshots, session/control/draft CAS, optional section revision, single-winner decisions; atomic raw settings transforms preserve background updates and inherited defaults | Task/plan revision checks across all writers, the rest of the Query ownership migration, and cross-process settings coordination       |
| Resumable realtime                            | Durable commit-ordered session event replay, coherent cursor, bounded snapshot, gap recovery and transport budgets                                                                                      | Full task/approval semantic outbox, retained-log run offsets, retention/compaction policy                                              |
| Runner boundary and ownership                 | Local runner adapter, cancellable admission, stable accounting, generation checks, conservative recovery                                                                                                | Database-fenced multi-process run owners and isolated process ownership verification                                                   |
| Draft/published separation                    | Reviewed SPEC workflow, immutable revisions, bound approval, candidate gates, effect reconciliation                                                                                                     | Migrate legacy autosaves/publication and approval continuations to this protocol; durable deployment publication operations            |
| Explicit execution deployment modes           | Trusted local pilot, scoped project credentials, trusted host-only publication                                                                                                                          | Isolated remote runners, scoped execution credentials/resource budgets, immutable remote artifact intake and multiple backend replicas |

These remaining items are not claimed as implemented. Full shared-host product support requires the rest of the authorization/revision/outbox rollout. Mutually untrusted repository hosting and multiple backend replicas remain outside the pilot. Microservices, a broker, universal event sourcing and CRDT editing remain deferred as recommended by the source review.
