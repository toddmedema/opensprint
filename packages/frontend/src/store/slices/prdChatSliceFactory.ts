import { createSlice, createAsyncThunk, type PayloadAction, type Slice } from "@reduxjs/toolkit";
import type { PrdChangeLogEntry } from "@opensprint/shared";
import { api } from "../../api/client";
import { parsePrdSections } from "../../lib/prdUtils";

/** Message shape used across PRD chat slices */
export interface PrdChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

/** State shape shared by spec/design/sketch PRD chat slices */
export interface PrdChatState {
  messages: PrdChatMessage[];
  prdContent: Record<string, string>;
  prdHistory: PrdChangeLogEntry[];
  sendingChat: boolean;
  savingSections: string[];
  error: string | null;
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
  slice: Slice<PrdChatState, Record<string, unknown>, string>;
  thunks: {
    fetchChat: ReturnType<typeof createAsyncThunk>;
    fetchPrd: ReturnType<typeof createAsyncThunk>;
    fetchPrdHistory: ReturnType<typeof createAsyncThunk>;
    sendMessage: ReturnType<typeof createAsyncThunk>;
    savePrdSection: ReturnType<typeof createAsyncThunk>;
    uploadPrdFile: ReturnType<typeof createAsyncThunk>;
  };
}

/**
 * Factory that creates a PRD chat slice with the given name.
 * Produces slice, reducers, and async thunks. Use for spec, design, sketch, etc.
 */
export function createPrdChatSlice(sliceName: string): PrdChatSliceResult {
  const prefix = `${sliceName}/`;

  const fetchChat = createAsyncThunk(
    `${prefix}fetchChat`,
    async (projectId: string) => {
      const conv = await api.chat.history(projectId, sliceName);
      return conv?.messages ?? [];
    }
  );

  const fetchPrd = createAsyncThunk(`${prefix}fetchPrd`, async (projectId: string) => {
    const data = await api.prd.get(projectId);
    return parsePrdSections(data);
  });

  const fetchPrdHistory = createAsyncThunk(`${prefix}fetchPrdHistory`, async (projectId: string) => {
    const data = await api.prd.getHistory(projectId);
    return data ?? [];
  });

  const sendMessage = createAsyncThunk(
    `${prefix}sendMessage`,
    async ({
      projectId,
      message,
      prdSectionFocus,
    }: {
      projectId: string;
      message: string;
      prdSectionFocus?: string;
    }) => {
      return api.chat.send(projectId, message, sliceName, prdSectionFocus);
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
        .addCase(fetchPrdHistory.fulfilled, (state, action) => {
          state.prdHistory = action.payload;
        })
        .addCase(sendMessage.pending, (state) => {
          state.sendingChat = true;
          state.error = null;
        })
        .addCase(sendMessage.fulfilled, (state, action) => {
          state.sendingChat = false;
          state.messages.push({
            role: "assistant",
            content: action.payload.message,
            timestamp: new Date().toISOString(),
          });
        })
        .addCase(sendMessage.rejected, (state, action) => {
          state.sendingChat = false;
          state.error = action.error.message || "Failed to send message";
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
          state.error = action.error.message || "Failed to save PRD section";
        })
        .addCase(uploadPrdFile.pending, (state) => {
          state.sendingChat = true;
          state.error = null;
        })
        .addCase(uploadPrdFile.fulfilled, (state, action) => {
          state.sendingChat = false;
          if (action.payload.response) {
            state.messages.push({
              role: "assistant",
              content: action.payload.response.message,
              timestamp: new Date().toISOString(),
            });
          }
        })
        .addCase(uploadPrdFile.rejected, (state, action) => {
          state.sendingChat = false;
          state.error = action.error.message || "Failed to process uploaded file";
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
