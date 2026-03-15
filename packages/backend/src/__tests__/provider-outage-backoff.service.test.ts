import { describe, expect, it } from "vitest";
import {
  clearProviderOutageBackoff,
  getProviderOutageBackoff,
  markProviderOutageBackoff,
} from "../services/provider-outage-backoff.service.js";

describe("provider-outage-backoff", () => {
  it("starts with a five-minute backoff and escalates repeated outages", () => {
    const projectId = "proj-backoff-escalation";
    const startMs = Date.parse("2026-03-15T12:00:00.000Z");

    const first = markProviderOutageBackoff(
      projectId,
      "CURSOR_API_KEY",
      "Failed to reach the Cursor API",
      startMs
    );
    const second = markProviderOutageBackoff(
      projectId,
      "CURSOR_API_KEY",
      "Failed to reach the Cursor API",
      startMs + 60_000
    );

    expect(first.durationMs).toBe(5 * 60_000);
    expect(second.durationMs).toBe(15 * 60_000);
    expect(getProviderOutageBackoff(projectId, "CURSOR_API_KEY", startMs + 60_000)).toEqual(
      expect.objectContaining({
        attempts: 2,
        until: new Date(startMs + 60_000 + 15 * 60_000).toISOString(),
      })
    );

    clearProviderOutageBackoff(projectId, "CURSOR_API_KEY");
  });

  it("expires backoff automatically after the cooldown window", () => {
    const projectId = "proj-backoff-expiry";
    const startMs = Date.parse("2026-03-15T13:00:00.000Z");

    markProviderOutageBackoff(
      projectId,
      "CURSOR_API_KEY",
      "Failed to reach the Cursor API",
      startMs
    );

    expect(
      getProviderOutageBackoff(projectId, "CURSOR_API_KEY", startMs + 4 * 60_000)
    ).not.toBeNull();
    expect(getProviderOutageBackoff(projectId, "CURSOR_API_KEY", startMs + 6 * 60_000)).toBeNull();
  });
});
