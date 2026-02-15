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
  source: "design" | "plan" | "build" | "validate";
  timestamp: string;
  diff: string;
}

/** Full PRD document stored at .opensprint/prd.json */
export interface Prd {
  version: number;
  sections: Record<PrdSectionKey, PrdSection>;
  changeLog: PrdChangeLogEntry[];
}
