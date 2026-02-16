#!/usr/bin/env node
/**
 * CLI: Check whether all blocks dependencies for a task are closed.
 * Used by agent-chain.sh as a pre-flight guard before claiming a task.
 *
 * Usage: npx tsx src/scripts/check-blockers-closed.ts <task-id>
 * Run from repo root (cwd = project repo with .beads).
 * Exit 0 if all blockers closed, 1 otherwise.
 */

import path from 'path';
import fs from 'fs';
import { BeadsService } from '../services/beads.service.js';

const taskId = process.argv[2];
if (!taskId) {
  console.error('Usage: check-blockers-closed <task-id>');
  process.exit(1);
}

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.beads'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return start;
}

const repoPath = findRepoRoot(process.cwd());
const beads = new BeadsService();

beads
  .areAllBlockersClosed(repoPath, taskId)
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error('[check-blockers-closed]', err.message);
    process.exit(1);
  });
