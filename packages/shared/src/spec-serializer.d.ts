/**
 * Serialize/deserialize the Sketch phase output (SPEC.md) to/from the Prd type.
 * SPEC.md is a flat markdown file at repo root with standard section headers.
 */
import type { Prd, PrdChangeLogEntry } from "./types/prd.js";
/** Serialize Prd to SPEC.md markdown. */
export declare function prdToSpecMarkdown(prd: Prd): string;
/** Parse SPEC.md markdown into Prd. Sections are extracted by ## headers. */
export declare function specMarkdownToPrd(
  markdown: string,
  metadata?: {
    version: number;
    changeLog: PrdChangeLogEntry[];
  }
): Prd;
//# sourceMappingURL=spec-serializer.d.ts.map
