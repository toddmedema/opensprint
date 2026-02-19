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
  section: PrdSectionKey;
  version: number;
  source: "sketch" | "plan" | "execute" | "eval" | "deliver";
  timestamp: string;
  diff: string;
}

/** Change log entry as stored on disk; may include legacy "spec" source (normalized to "sketch" when loading) */
export type PrdChangeLogEntryFromDisk = Omit<PrdChangeLogEntry, "source"> & {
  source: PrdChangeLogEntry["source"] | "spec";
};

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

/** Full PRD document stored at .opensprint/prd.json */
export interface Prd {
  version: number;
  sections: Record<PrdSectionKey, PrdSection>;
  changeLog: PrdChangeLogEntry[];
}

/** PRD as loaded from disk; changeLog may contain legacy "spec" source */
export interface PrdFromDisk extends Omit<Prd, "changeLog"> {
  changeLog: PrdChangeLogEntryFromDisk[];
}
