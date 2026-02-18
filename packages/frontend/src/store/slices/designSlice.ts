import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { PrdChangeLogEntry } from "@opensprint/shared";
import { api } from "../../api/client";
import { parsePrdSections } from "../../lib/prdUtils";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface DesignState {
  messages: Message[];
  prdContent: Record<string, string>;
  prdHistory: PrdChangeLogEntry[];
  sendingChat: boolean;
  /** Sections currently being saved (allows concurrent multi-section edits) */
  savingSections: string[];
  error: string | null;
}

const initialState: DesignState = {
  messages: [],
  prdContent: {},
  prdHistory: [],
  sendingChat: false,
  savingSections: [],
  error: null,
};

export const fetchDesignChat = createAsyncThunk("design/fetchChat", async (projectId: string) => {
  const conv = await api.chat.history(projectId, "sketch");
  return conv?.messages ?? [];
});

export const fetchPrd = createAsyncThunk("design/fetchPrd", async (projectId: string) => {
  const data = await api.prd.get(projectId);
  return parsePrdSections(data);
});

export const fetchPrdHistory = createAsyncThunk("design/fetchPrdHistory", async (projectId: string) => {
  const data = await api.prd.getHistory(projectId);
  return data ?? [];
});

export const sendDesignMessage = createAsyncThunk(
  "design/sendMessage",
  async ({ projectId, message, prdSectionFocus }: { projectId: string; message: string; prdSectionFocus?: string }) => {
    return api.chat.send(projectId, message, "sketch", prdSectionFocus);
  },
);

export const savePrdSection = createAsyncThunk(
  "design/savePrdSection",
  async ({ projectId, section, content }: { projectId: string; section: string; content: string }) => {
    await api.prd.updateSection(projectId, section, content);
    return { section, content };
  },
);

export const uploadPrdFile = createAsyncThunk(
  "design/uploadPrdFile",
  async ({ projectId, file }: { projectId: string; file: File }) => {
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "md") {
      const text = await file.text();
      const prompt = `Here's my existing product requirements document. Please analyze it and generate a structured PRD from it:\n\n${text}`;
      const response = await api.chat.send(projectId, prompt, "sketch");
      return { response, fileName: file.name };
    } else if (ext === "docx" || ext === "pdf") {
      const result = await api.prd.upload(projectId, file);
      if (result.text) {
        const prompt = `Here's my existing product requirements document. Please analyze it and generate a structured PRD from it:\n\n${result.text}`;
        const response = await api.chat.send(projectId, prompt, "sketch");
        return { response, fileName: file.name };
      }
      return { response: null, fileName: file.name };
    }

    throw new Error("Unsupported file type. Please use .md, .docx, or .pdf");
  },
);

const designSlice = createSlice({
  name: "design",
  initialState,
  reducers: {
    addUserMessage(state, action: PayloadAction<Message>) {
      state.messages.push(action.payload);
    },
    setDesignError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setPrdContent(state, action: PayloadAction<Record<string, string>>) {
      state.prdContent = action.payload;
    },
    setPrdHistory(state, action: PayloadAction<PrdChangeLogEntry[]>) {
      state.prdHistory = action.payload;
    },
    resetDesign() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      // fetchDesignChat
      .addCase(fetchDesignChat.fulfilled, (state, action) => {
        state.messages = action.payload;
      })
      // fetchPrd
      .addCase(fetchPrd.fulfilled, (state, action) => {
        state.prdContent = action.payload;
      })
      // fetchPrdHistory
      .addCase(fetchPrdHistory.fulfilled, (state, action) => {
        state.prdHistory = action.payload;
      })
      // sendDesignMessage
      .addCase(sendDesignMessage.pending, (state) => {
        state.sendingChat = true;
        state.error = null;
      })
      .addCase(sendDesignMessage.fulfilled, (state, action) => {
        state.sendingChat = false;
        state.messages.push({
          role: "assistant",
          content: action.payload.message,
          timestamp: new Date().toISOString(),
        });
      })
      .addCase(sendDesignMessage.rejected, (state, action) => {
        state.sendingChat = false;
        state.error = action.error.message ?? "Failed to send message";
      })
      // savePrdSection
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
        state.error = action.error.message ?? "Failed to save PRD section";
      })
      // uploadPrdFile
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
        state.error = action.error.message ?? "Failed to process uploaded file";
      });
  },
});

export const { addUserMessage, setDesignError, setPrdContent, setPrdHistory, resetDesign } = designSlice.actions;
export default designSlice.reducer;
