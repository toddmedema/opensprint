import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import { api } from "../../api/client";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface PrdChangeLogEntry {
  section: string;
  version: number;
  source: "dream" | "plan" | "build" | "verify";
  timestamp: string;
  diff: string;
}

export interface DesignState {
  messages: Message[];
  prdContent: Record<string, string>;
  prdHistory: PrdChangeLogEntry[];
  sendingChat: boolean;
  savingSection: string | null;
  error: string | null;
}

const initialState: DesignState = {
  messages: [],
  prdContent: {},
  prdHistory: [],
  sendingChat: false,
  savingSection: null,
  error: null,
};

function parsePrdSections(prd: unknown): Record<string, string> {
  const data = prd as { sections?: Record<string, { content: string }> };
  const content: Record<string, string> = {};
  if (data?.sections) {
    for (const [key, section] of Object.entries(data.sections)) {
      content[key] = section.content;
    }
  }
  return content;
}

export const fetchDesignChat = createAsyncThunk("design/fetchChat", async (projectId: string) => {
  const data = await api.chat.history(projectId, "dream");
  const conv = data as { messages?: Message[] };
  return conv?.messages ?? [];
});

export const fetchPrd = createAsyncThunk("design/fetchPrd", async (projectId: string) => {
  const data = await api.prd.get(projectId);
  return parsePrdSections(data);
});

export const fetchPrdHistory = createAsyncThunk("design/fetchPrdHistory", async (projectId: string) => {
  const data = await api.prd.getHistory(projectId);
  return (data as PrdChangeLogEntry[]) ?? [];
});

export const sendDesignMessage = createAsyncThunk(
  "design/sendMessage",
  async ({ projectId, message, prdSectionFocus }: { projectId: string; message: string; prdSectionFocus?: string }) => {
    const response = (await api.chat.send(projectId, message, "dream", prdSectionFocus)) as {
      message: string;
      prdChanges?: { section: string; previousVersion: number; newVersion: number }[];
    };
    return response;
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
      const response = (await api.chat.send(projectId, prompt, "dream")) as {
        message: string;
        prdChanges?: { section: string; previousVersion: number; newVersion: number }[];
      };
      return { response, fileName: file.name };
    } else if (ext === "docx" || ext === "pdf") {
      const result = await api.prd.upload(projectId, file);
      const uploadResult = result as { text?: string; message?: string };
      if (uploadResult.text) {
        const prompt = `Here's my existing product requirements document. Please analyze it and generate a structured PRD from it:\n\n${uploadResult.text}`;
        const response = (await api.chat.send(projectId, prompt, "dream")) as {
          message: string;
          prdChanges?: { section: string; previousVersion: number; newVersion: number }[];
        };
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
        state.savingSection = action.meta.arg.section;
      })
      .addCase(savePrdSection.fulfilled, (state) => {
        state.savingSection = null;
      })
      .addCase(savePrdSection.rejected, (state, action) => {
        state.savingSection = null;
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
