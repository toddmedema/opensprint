import { createPrdChatSlice } from "./prdChatSliceFactory";
import type { PrdChatState } from "./prdChatSliceFactory";

const { slice, thunks } = createPrdChatSlice("design");

export type DesignState = PrdChatState;

export const fetchDesignChat = thunks.fetchChat;
export const fetchPrd = thunks.fetchPrd;
export const fetchPrdHistory = thunks.fetchPrdHistory;
export const sendDesignMessage = thunks.sendMessage;
export const savePrdSection = thunks.savePrdSection;
export const uploadPrdFile = thunks.uploadPrdFile;

const { addUserMessage, setError, setPrdContent, setPrdHistory, reset } = slice.actions;

export { addUserMessage, setPrdContent, setPrdHistory };
export const setDesignError = setError;
export const resetDesign = reset;

export default slice.reducer;
