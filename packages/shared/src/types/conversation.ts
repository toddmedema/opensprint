/** Conversation context — which phase/plan it belongs to */
export type ConversationContext = "sketch" | `plan:${string}`;

/** A message in a conversation */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  prdChanges?: PrdChangeReference[];
}

/** Reference to a PRD change made as a result of a message */
export interface PrdChangeReference {
  section: string;
  previousVersion: number;
  newVersion: number;
}

/** Conversation entity stored at .opensprint/conversations/<id>.json */
export interface Conversation {
  id: string;
  context: ConversationContext;
  messages: ConversationMessage[];
}
