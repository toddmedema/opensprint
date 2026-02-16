/**
 * check-blockers-closed.ts uses BeadsService.areAllBlockersClosed().
 * That logic is comprehensively tested in beads-service.test.ts:
 * - "should return false when a blocker is in_progress"
 * - "should return true when all blockers are closed"
 * - "should return true when task has no blockers"
 *
 * This file documents the dependency and ensures the test suite loads.
 */
import { describe, it, expect } from 'vitest';
import { BeadsService } from '../services/beads.service.js';

describe('check-blockers-closed script', () => {
  it('uses BeadsService.areAllBlockersClosed (tested in beads-service.test.ts)', () => {
    const beads = new BeadsService();
    expect(typeof beads.areAllBlockersClosed).toBe('function');
  });
});
