import { taskStore } from "./task-store.service.js";
import {
  assertExecutionFenceInTransaction,
  type ExecutionFence,
} from "./execution-ownership.service.js";

export const OUTPUT_RETENTION_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
export interface ExecutionOutputPage {
  attemptId: string;
  startOffset: number;
  endOffset: number;
  nextOffset: number;
  content: string;
  status: "ok" | "offset_expired" | "unknown_attempt";
}

/** Byte offsets are durable per attempt. Retention never silently rewinds a reconnecting reader. */
export class ExecutionOutputService {
  constructor(
    private readonly injectedStore?: Pick<typeof taskStore, "runWrite" | "runRead" | "getDb">,
    private readonly retentionBytes = OUTPUT_RETENTION_BYTES
  ) {}
  private get store(): Pick<typeof taskStore, "runWrite" | "runRead" | "getDb"> {
    return this.injectedStore ?? taskStore;
  }

  async append(
    fence: ExecutionFence,
    content: string
  ): Promise<{ startOffset: number; endOffset: number }> {
    return this.store.runWrite(async (tx) => {
      await assertExecutionFenceInTransaction(tx, fence);
      const now = new Date().toISOString();
      await tx.execute(
        `INSERT INTO execution_output_streams
        (project_id,task_id,attempt_id,start_offset,end_offset,updated_at) VALUES ($1,$2,$3,0,0,$4)
        ON CONFLICT (project_id,attempt_id) DO NOTHING`,
        [fence.projectId, fence.taskId, fence.attemptId, now]
      );
      // Lock stream row for PostgreSQL writers independently of this backend's JS queue.
      await tx.execute(
        `UPDATE execution_output_streams SET updated_at=$1 WHERE project_id=$2 AND attempt_id=$3`,
        [now, fence.projectId, fence.attemptId]
      );
      const stream = await tx.queryOne(
        `SELECT * FROM execution_output_streams WHERE project_id=$1 AND attempt_id=$2`,
        [fence.projectId, fence.attemptId]
      );
      const start = Number(stream!.end_offset);
      let end = start;
      // Split on code points; offsets refer to UTF-8 bytes and never cut a multibyte character.
      let chunk = "";
      let bytes = 0;
      const flush = async () => {
        if (!chunk) return;
        await tx.execute(
          `INSERT INTO execution_output_chunks
        (project_id,attempt_id,start_offset,end_offset,content) VALUES ($1,$2,$3,$4,$5)`,
          [fence.projectId, fence.attemptId, end, end + bytes, chunk]
        );
        end += bytes;
        chunk = "";
        bytes = 0;
      };
      for (const char of content) {
        const n = Buffer.byteLength(char);
        if (bytes + n > MAX_CHUNK_BYTES) await flush();
        chunk += char;
        bytes += n;
      }
      await flush();
      await tx.execute(
        `DELETE FROM execution_output_chunks WHERE project_id=$1 AND attempt_id=$2 AND start_offset < $3`,
        [fence.projectId, fence.attemptId, end - this.retentionBytes]
      );
      const first = await tx.queryOne(
        `SELECT MIN(start_offset) AS first FROM execution_output_chunks WHERE project_id=$1 AND attempt_id=$2`,
        [fence.projectId, fence.attemptId]
      );
      await tx.execute(
        `UPDATE execution_output_streams SET start_offset=$1,end_offset=$2 WHERE project_id=$3 AND attempt_id=$4`,
        [first?.first == null ? end : Number(first.first), end, fence.projectId, fence.attemptId]
      );
      // Bounded history: no abandoned per-attempt logs grow forever. Active attempts are protected.
      const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      await tx.execute(
        `DELETE FROM execution_output_chunks WHERE project_id=$1 AND attempt_id IN
        (SELECT attempt_id FROM execution_output_streams WHERE project_id=$1 AND (updated_at < $2 OR attempt_id NOT IN
          (SELECT attempt_id FROM execution_output_streams WHERE project_id=$1 ORDER BY updated_at DESC,attempt_id DESC LIMIT 100)))
        AND attempt_id NOT IN (SELECT attempt_id FROM execution_leases WHERE project_id=$1 AND state IN ('queued','running','stop_requested','uncertain'))`,
        [fence.projectId, cutoff]
      );
      await tx.execute(
        `DELETE FROM execution_output_streams WHERE project_id=$1 AND (updated_at < $2 OR attempt_id NOT IN
        (SELECT attempt_id FROM execution_output_streams WHERE project_id=$1 ORDER BY updated_at DESC,attempt_id DESC LIMIT 100))
        AND attempt_id NOT IN (SELECT attempt_id FROM execution_leases WHERE project_id=$1 AND state IN ('queued','running','stop_requested','uncertain'))`,
        [fence.projectId, cutoff]
      );
      return { startOffset: start, endOffset: end };
    });
  }
  async read(
    projectId: string,
    attemptId: string,
    offset = 0,
    maxBytes = 256 * 1024
  ): Promise<ExecutionOutputPage> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Output offset must be a nonnegative safe integer");
    // Metadata and chunks must share a snapshot while another backend trims retention.
    return this.store.runRead(async (tx) => {
      const stream = await tx.queryOne(
        `SELECT * FROM execution_output_streams WHERE project_id=$1 AND attempt_id=$2`,
        [projectId, attemptId]
      );
      if (!stream)
        return {
          attemptId,
          startOffset: 0,
          endOffset: 0,
          nextOffset: 0,
          content: "",
          status: "unknown_attempt",
        };
      const startOffset = Number(stream.start_offset),
        endOffset = Number(stream.end_offset);
      if (offset < startOffset)
        return {
          attemptId,
          startOffset,
          endOffset,
          nextOffset: startOffset,
          content: "",
          status: "offset_expired",
        };
      if (offset > endOffset) throw new Error("Output offset is beyond this attempt's end");
      const rows = await tx.query(
        `SELECT * FROM execution_output_chunks WHERE project_id=$1 AND attempt_id=$2 AND end_offset > $3 ORDER BY start_offset LIMIT 8`,
        [projectId, attemptId, offset]
      );
      let content = "",
        nextOffset = offset;
      for (const row of rows) {
        const buffer = Buffer.from(String(row.content));
        const consumed = Math.max(0, offset - Number(row.start_offset));
        // Require a UTF-8 boundary for client supplied offsets.
        if (consumed < buffer.length && (buffer[consumed]! & 0xc0) === 0x80)
          throw new Error("Output offset must be on a UTF-8 boundary");
        const text = buffer.subarray(consumed).toString("utf8");
        if (
          Buffer.byteLength(content) + Buffer.byteLength(text) >
          Math.max(MAX_CHUNK_BYTES, Math.min(maxBytes, 512 * 1024))
        )
          break;
        content += text;
        nextOffset = Number(row.end_offset);
      }
      return { attemptId, startOffset, endOffset, nextOffset, content, status: "ok" };
    });
  }
}
export const executionOutputService = new ExecutionOutputService();
