import type { CollaborationEvent } from "@opensprint/shared";

/** Describe committed discussion and control events using the caller's current actor labels. */
export function collaborationEventLabel(
  event: CollaborationEvent,
  name: (id: string) => string
): string {
  const who = name(event.actorId);
  if ("content" in event.payload)
    return `${who}${event.payload.decision ? " recorded a decision" : " said"}: ${event.payload.content}`;
  const run = event.payload;
  if (event.type === "control_requested")
    return `${who} requested control for ${name(run.request?.targetActorId ?? event.actorId)}`;
  if (event.type === "control_request_resolved") return `${who} resolved a control request`;
  if (!run.controllerId) return `${who} released control`;
  return `${who} ${event.type === "control_claimed" ? "claimed" : "handed over"} control${event.type === "control_claimed" ? "" : ` to ${name(run.controllerId)}`}`;
}
