/**
 * PrdProposalStore — in-memory store for pending PRD/SPEC HIL approval proposals.
 *
 * When a PRD/SPEC approval HIL request is created, the full proposed SPEC.md
 * content is registered here keyed by the notification requestId.  The
 * proposed-diff endpoint (and future consumers) resolve proposals from this
 * store instead of re-deriving them from notification metadata.
 *
 * Entries are automatically swept after a configurable TTL so the map does not
 * grow unbounded if the user never responds.  Explicit removal happens on
 * resolve/dismiss via {@link remove}.
 */

import crypto from "crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("prd-proposal-store");

export interface PrdProposal {
  proposedContent: string;
  createdAt: string;
  baseContentHash?: string;
}

/** Internal entry adds an expiry timestamp for TTL sweep. */
interface PrdProposalEntry extends PrdProposal {
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class PrdProposalStore {
  private proposals = new Map<string, PrdProposalEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number; sweepIntervalMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    const sweepInterval = opts?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /** Durable production proposal; the cache API below remains for legacy callers. */
  async registerDurable(
    projectId: string,
    requestId: string,
    content: string,
    baseContent: string
  ): Promise<void> {
    const { specPublicationService } = await import("./spec-publication.service.js");
    await specPublicationService.recordProposal(projectId, requestId, content, baseContent);
  }

  async getDurable(requestId: string): Promise<PrdProposal | null> {
    const { specPublicationService } = await import("./spec-publication.service.js");
    const row = await specPublicationService.getProposal(requestId);
    return row
      ? {
          proposedContent: String(row.content),
          createdAt: String(row.created_at),
          baseContentHash: String(row.base_content_hash),
        }
      : this.get(requestId);
  }

  /**
   * Register a pending PRD proposal keyed by the HIL notification requestId.
   * If `baseContent` is provided its SHA-256 hex digest is stored as
   * `baseContentHash` for staleness detection.
   */
  register(requestId: string, proposedContent: string, baseContent?: string): PrdProposal {
    const createdAt = new Date().toISOString();
    const baseContentHash = baseContent ? hashSpecContent(baseContent) : undefined;
    const entry: PrdProposalEntry = {
      proposedContent,
      createdAt,
      baseContentHash,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.proposals.set(requestId, entry);
    log.info("Registered PRD proposal", {
      requestId,
      contentLength: proposedContent.length,
      baseContentHash,
    });
    return { proposedContent, createdAt, baseContentHash };
  }

  /**
   * Look up a pending proposal by requestId.
   * Returns `null` when not found or expired (expired entries are lazily
   * removed on access as well as by the periodic sweep).
   */
  get(requestId: string): PrdProposal | null {
    const entry = this.proposals.get(requestId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.proposals.delete(requestId);
      log.info("Lazily expired PRD proposal on access", { requestId });
      return null;
    }
    return {
      proposedContent: entry.proposedContent,
      createdAt: entry.createdAt,
      baseContentHash: entry.baseContentHash,
    };
  }

  /**
   * Explicitly remove a proposal (on resolve, dismiss, or cancel).
   * Returns `true` if the entry existed.
   */
  remove(requestId: string): boolean {
    const existed = this.proposals.delete(requestId);
    if (existed) {
      log.info("Removed PRD proposal", { requestId });
    }
    return existed;
  }

  /** Number of proposals currently stored (includes not-yet-swept expired). */
  get size(): number {
    return this.proposals.size;
  }

  /** Remove all expired entries. Called periodically by the sweep timer. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of this.proposals) {
      if (now > entry.expiresAt) {
        this.proposals.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      log.info("Swept expired PRD proposals", { removed, remaining: this.proposals.size });
    }
    return removed;
  }

  /** Stop the sweep timer. Call on shutdown to avoid dangling timers in tests. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

/** SHA-256 hex of UTF-8 SPEC body; shared with PRD proposed-diff staleness checks. */
export function hashSpecContent(content: string): string {
  return crypto.createHash("sha256").update(content.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

/** Singleton instance used by the rest of the backend. */
export const prdProposalStore = new PrdProposalStore();
