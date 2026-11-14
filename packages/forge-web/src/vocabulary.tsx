import { createContext, useContext, useMemo, type ReactNode } from "react";

export type Vocabulary = {
  project: string;
  frame: string;
  workItem: string;
  agent: string;
  runbook: string;
};

export const DEFAULT_NAMES: Vocabulary = {
  project: "project",
  frame: "frame",
  workItem: "work item",
  agent: "agent",
  runbook: "runbook",
};

const VocabularyContext = createContext<{ names: Vocabulary }>({ names: DEFAULT_NAMES });

export function VocabularyProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => ({ names: DEFAULT_NAMES }), []);
  return <VocabularyContext.Provider value={value}>{children}</VocabularyContext.Provider>;
}

export function useVocabulary(): { names: Vocabulary } {
  return useContext(VocabularyContext);
}
