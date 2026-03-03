import {
  createSlice,
  createAsyncThunk,
  type PayloadAction,
  type Slice,
  type SliceCaseReducers,
} from "@reduxjs/toolkit";
import type { ChatResponse, PrdChangeLogEntry } from "@opensprint/shared";
import { api } from "../../api/client";
import { parsePrdSections } from "../../lib/prdUtils";
import { isNotificationManagedAgentFailure } from "../../lib/agentApiError";

/** Message shape used across PRD chat slices */
export interface PrdChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

/** State shape shared by Sketch (and other PRD chat) slices */
export interface PrdChatState {
  messages: PrdChatMessage[];
  prdContent: Record<string, string>;
  prdHistory: PrdChangeLogEntry[];
  sendingChat: boolean;
  savingSections: string[];
  error: string | null;
}

/** Backend sends this when the agent returned a known error (e.g. credit balance, rate limit). */
function isKnownAgentErrorMessage(message: string): boolean {
  if (!message || typeof message !== "string") return false;
  return (
    message.includes("The planning agent could not complete your request") ||
    message.includes("**What to try:**")
  );
}

/** Read file as text; uses FileReader when file.text() is not available (e.g. jsdom) */
async function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("Failed to read file"));
    r.readAsText(file);
  });
}

const createInitialState = (): PrdChatState => ({
  messages: [],
  prdContent: {},
  prdHistory: [],
  sendingChat: false,
  savingSections: [],
  error: null,
});

export interface PrdChatSliceResult {
  slice: Slice<PrdChatState, SliceCaseReducers<PrdChatState>, string>;
  thunks: {
    fetchChat: ReturnType<typeof createAsyncThunk<PrdChatMessage[], string>>;
    fetchPrd: ReturnType<typeof createAsyncThunk<Record<string, string>, string>>;
    fetchPrdHistory: ReturnType<typeof createAsyncThunk<PrdChangeLogEntry[], string>>;
    sendMessage: ReturnType<
      typeof createAsyncThunk<
        ChatResponse,
        { projectId: string; message: string; prdSectionFocus?: string; images?: string[] }
      >
    >;
    savePrdSection: ReturnType<
      typeof createAsyncThunk<
        { section: string; content: string },
        { projectId: string; section: string; content: string }
      >
    >;
    uploadPrdFile: ReturnType<
      typeof createAsyncThunk<
        { response: ChatResponse | null; fileName: string },
        { projectId: string; file: File }
      >
    >;
  };
}

/**
 * Factory that creates a PRD chat slice with the given name.
 * Produces slice, reducers, and async thunks. Used for Sketch and other PRD chat contexts.
 */
export function createPrdChatSlice(sliceName: string): PrdChatSliceResult {
  const prefix = `${sliceName}/`;

  const fetchChat = createAsyncThunk(`${prefix}fetchChat`, async (projectId: string) => {
    const conv = await api.chat.history(projectId, sliceName);
    return conv?.messages ?? [];
  });

  const fetchPrd = createAsyncThunk(`${prefix}fetchPrd`, async (projectId: string) => {
    const data = await api.prd.get(projectId);
    return parsePrdSections(data);
  });

  const fetchPrdHistory = createAsyncThunk(
    `${prefix}fetchPrdHistory`,
    async (projectId: string) => {
      const data = await api.prd.getHistory(projectId);
      return data ?? [];
    }
  );

  const sendMessage = createAsyncThunk(
    `${prefix}sendMessage`,
    async ({
      projectId,
      message,
      prdSectionFocus,
      images,
    }: {
      projectId: string;
      message: string;
      prdSectionFocus?: string;
      images?: string[];
    }) => {
      return api.chat.send(projectId, message, sliceName, prdSectionFocus, images);
    }
  );

  const savePrdSection = createAsyncThunk(
    `${prefix}savePrdSection`,
    async ({
      projectId,
      section,
      content,
    }: {
      projectId: string;
      section: string;
      content: string;
    }) => {
      await api.prd.updateSection(projectId, section, content);
      return { section, content };
    }
  );

  const uploadPrdFile = createAsyncThunk(
    `${prefix}uploadPrdFile`,
    async ({ projectId, file }: { projectId: string; file: File }) => {
      const ext = file.name.split(".").pop()?.toLowerCase();

      if (ext === "md") {
        const text = await readFileAsText(file);
        const prompt = `Here's my existing product requirements document. Please analyze it and generate a structured PRD from it:\n\n${text}`;
        const response = await api.chat.send(projectId, prompt, sliceName);
        return { response, fileName: file.name };
      } else if (ext === "docx" || ext === "pdf") {
        const result = await api.prd.upload(projectId, file);
        if (result.text) {
          const prompt = `Here's my existing product requirements document. Please analyze it and generate a structured PRD from it:\n\n${result.text}`;
          const response = await api.chat.send(projectId, prompt, sliceName);
          return { response, fileName: file.name };
        }
        return { response: null, fileName: file.name };
      }

      throw new Error("Unsupported file type. Please use .md, .docx, or .pdf");
    }
  );

  const initialState = createInitialState();

  const slice = createSlice({
    name: sliceName,
    initialState,
    reducers: {
      addUserMessage(state, action: PayloadAction<PrdChatMessage>) {
        state.messages.push(action.payload);
      },
      setError(state, action: PayloadAction<string | null>) {
        state.error = action.payload;
      },
      setPrdContent(state, action: PayloadAction<Record<string, string>>) {
        state.prdContent = action.payload;
      },
      setPrdHistory(state, action: PayloadAction<PrdChangeLogEntry[]>) {
        state.prdHistory = action.payload;
      },
      /** Sync from TanStack Query (e.g. useSketchChat). */
      setMessages(state, action: PayloadAction<PrdChatMessage[]>) {
        state.messages = action.payload;
      },
      reset() {
        return initialState;
      },
    },
    extraReducers: (builder) => {
      builder
        .addCase(fetchChat.fulfilled, (state, action) => {
          state.messages = action.payload;
        })
        .addCase(fetchPrd.fulfilled, (state, action) => {
          state.prdContent = action.payload;
        })
        .addCase(fetchPrd.rejected, (state, action) => {
          // PRD not found (e.g. adopted repo) — treat as empty so UI shows initial prompt
          const code = (action.error as { code?: string })?.code;
          if (code === "PRD_NOT_FOUND") {
            state.prdContent = {};
          }
        })
        .addCase(fetchPrdHistory.fulfilled, (state, action) => {
          state.prdHistory = action.payload;
        })
        .addCase(sendMessage.pending, (state) => {
          state.sendingChat = true;
          state.error = null;
        })
        .addCase(sendMessage.fulfilled, (state, action) => {
          state.sendingChat = false;
          const msg = action.payload?.message ?? "";
          state.messages.push({
            role: "assistant",
            content: msg,
            timestamp: new Date().toISOString(),
          });
          if (isKnownAgentErrorMessage(msg)) {
            state.error = msg;
          }
          // Optimistically apply PRD updates from Dreamer response so UI reflects changes immediately
          const prdChanges = action.payload?.prdChanges;
          if (prdChanges?.length && state.prdContent != null) {
            for (const c of prdChanges) {
              if (c.content != null) {
                state.prdContent[c.section] = c.content;
              }
            }
          }
        })
        .addCase(sendMessage.rejected, (state, action) => {
          state.sendingChat = false;
          if (!isNotificationManagedAgentFailure(action.error)) {
            state.error = action.error.message || "Failed to send message";
          }
        })
        .addCase(savePrdSection.pending, (state, action) => {
          const section = action.meta.arg.section;
          if (!state.savingSections.includes(section)) {
            state.savingSections.push(section);
          }
        })
        .addCase(savePrdSection.fulfilled, (state, action) => {
          state.savingSections = state.savingSections.filter((s) => s !== action.meta.arg.section);
        })
        .addCase(savePrdSection.rejected, (state, action) => {
          state.savingSections = state.savingSections.filter((s) => s !== action.meta.arg.section);
          if (!isNotificationManagedAgentFailure(action.error)) {
            state.error = action.error.message || "Failed to save PRD section";
          }
        })
        .addCase(uploadPrdFile.pending, (state) => {
          state.sendingChat = true;
          state.error = null;
        })
        .addCase(uploadPrdFile.fulfilled, (state, action) => {
          state.sendingChat = false;
          const response = action.payload.response;
          if (response) {
            state.messages.push({
              role: "assistant",
              content: response.message,
              timestamp: new Date().toISOString(),
            });
            if (isKnownAgentErrorMessage(response.message)) {
              state.error = response.message;
            }
            // Apply PRD updates from Dreamer response (same as sendMessage) so UI reflects changes
            const prdChanges = response.prdChanges;
            if (prdChanges?.length && state.prdContent != null) {
              for (const c of prdChanges) {
                if (c.content != null) {
                  state.prdContent[c.section] = c.content;
                }
              }
            }
          }
        })
        .addCase(uploadPrdFile.rejected, (state, action) => {
          state.sendingChat = false;
          if (!isNotificationManagedAgentFailure(action.error)) {
            state.error = action.error.message || "Failed to process uploaded file";
          }
        });
    },
  });

  return {
    slice,
    thunks: {
      fetchChat,
      fetchPrd,
      fetchPrdHistory,
      sendMessage,
      savePrdSection,
      uploadPrdFile,
    },
  };
}
