/** Available PRD sections */
export type PrdSectionKey =
  | "executive_summary"
  | "problem_statement"
  | "user_personas"
  | "goals_and_metrics"
  | "feature_list"
  | "technical_architecture"
  | "data_model"
  | "api_contracts"
  | "non_functional_requirements"
  | "open_questions";

/** A single section of the PRD */
export interface PrdSection {
  content: string;
  version: number;
  updatedAt: string;
}

/** Change log entry for PRD modifications */
export interface PrdChangeLogEntry {
  section: string; // PrdSectionKey | dynamic section (e.g. competitive_landscape)
  version: number;
  source: "sketch" | "plan" | "execute" | "eval" | "deliver";
  timestamp: string;
  diff: string;
}

/** PRD section update response */
export interface PrdSectionUpdateResult {
  section: PrdSection;
  previousVersion: number;
  newVersion: number;
}

/** PRD upload response */
export interface PrdUploadResult {
  text: string;
  filename: string;
}

/** Full PRD document stored as SPEC.md at repo root (flat markdown) with metadata in .opensprint/spec-metadata.json */
export interface Prd {
  version: number;
  /** Sections keyed by identifier. Sketch agent may add dynamic sections (e.g. competitive_landscape). */
  sections: Record<string, PrdSection>;
  changeLog: PrdChangeLogEntry[];
}
