import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import specReducer, {
  addUserMessage,
  setSpecError,
  setPrdContent,
  setPrdHistory,
  resetSpec,
  fetchSpecChat,
  fetchPrd,
  fetchPrdHistory,
  sendSpecMessage,
  savePrdSection,
  uploadPrdFile,
  type SpecState,
} from "./specSlice";

vi.mock("../../api/client", () => ({
  api: {
    chat: {
      history: vi.fn(),
      send: vi.fn(),
    },
    prd: {
      get: vi.fn(),
      getHistory: vi.fn(),
      updateSection: vi.fn(),
      upload: vi.fn(),
    },
  },
}));

import { api } from "../../api/client";

const mockMessage = {
  role: "user" as const,
  content: "Hello",
  timestamp: "2025-01-01T00:00:00Z",
};

describe("specSlice", () => {
  beforeEach(() => {
    vi.mocked(api.chat.history).mockReset();
    vi.mocked(api.chat.send).mockReset();
    vi.mocked(api.prd.get).mockReset();
    vi.mocked(api.prd.getHistory).mockReset();
    vi.mocked(api.prd.updateSection).mockReset();
    vi.mocked(api.prd.upload).mockReset();
  });

  function createStore() {
    return configureStore({ reducer: { spec: specReducer } });
  }

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = createStore();
      const state = store.getState().spec as SpecState;
      expect(state.messages).toEqual([]);
      expect(state.prdContent).toEqual({});
      expect(state.prdHistory).toEqual([]);
      expect(state.sendingChat).toBe(false);
      expect(state.savingSections).toEqual([]);
      expect(state.error).toBeNull();
    });
  });

  describe("reducers", () => {
    it("addUserMessage appends message", () => {
      const store = createStore();
      store.dispatch(addUserMessage(mockMessage));
      expect(store.getState().spec.messages).toHaveLength(1);
      expect(store.getState().spec.messages[0]).toEqual(mockMessage);
    });

    it("setSpecError sets error", () => {
      const store = createStore();
      store.dispatch(setSpecError("Something went wrong"));
      expect(store.getState().spec.error).toBe("Something went wrong");
      store.dispatch(setSpecError(null));
      expect(store.getState().spec.error).toBeNull();
    });

    it("setPrdContent sets PRD content", () => {
      const store = createStore();
      const content = { overview: "Overview text", goals: "Goals text" };
      store.dispatch(setPrdContent(content));
      expect(store.getState().spec.prdContent).toEqual(content);
    });

    it("setPrdHistory sets PRD history", () => {
      const store = createStore();
      const history = [
        {
          section: "executive_summary" as const,
          version: 1,
          source: "sketch" as const,
          timestamp: "2025-01-01",
          diff: "old",
        },
      ];
      store.dispatch(setPrdHistory(history as never));
      expect(store.getState().spec.prdHistory).toEqual(history);
    });

    it("resetSpec resets to initial state", () => {
      const store = createStore();
      store.dispatch(addUserMessage(mockMessage));
      store.dispatch(setSpecError("error"));
      store.dispatch(setPrdContent({ overview: "x" }));

      store.dispatch(resetSpec());
      const state = store.getState().spec as SpecState;
      expect(state.messages).toEqual([]);
      expect(state.prdContent).toEqual({});
      expect(state.error).toBeNull();
    });
  });

  describe("fetchSpecChat thunk", () => {
    it("stores messages on fulfilled", async () => {
      const messages = [
        { role: "user" as const, content: "hi", timestamp: "2025-01-01" },
        { role: "assistant" as const, content: "hello", timestamp: "2025-01-01" },
      ];
      vi.mocked(api.chat.history).mockResolvedValue({ messages } as never);
      const store = createStore();
      await store.dispatch(fetchSpecChat("proj-1"));

      expect(store.getState().spec.messages).toEqual(messages);
      expect(api.chat.history).toHaveBeenCalledWith("proj-1", "sketch");
    });

    it("uses empty array when messages missing", async () => {
      vi.mocked(api.chat.history).mockResolvedValue({} as never);
      const store = createStore();
      await store.dispatch(fetchSpecChat("proj-1"));

      expect(store.getState().spec.messages).toEqual([]);
    });
  });

  describe("fetchPrd thunk", () => {
    it("stores parsed PRD sections on fulfilled", async () => {
      vi.mocked(api.prd.get).mockResolvedValue({
        sections: {
          overview: { content: "Overview", version: 1, updatedAt: "" },
          goals: { content: "Goals", version: 1, updatedAt: "" },
        },
      } as never);
      const store = createStore();
      await store.dispatch(fetchPrd("proj-1"));

      expect(store.getState().spec.prdContent).toEqual({ overview: "Overview", goals: "Goals" });
      expect(api.prd.get).toHaveBeenCalledWith("proj-1");
    });
  });

  describe("fetchPrdHistory thunk", () => {
    it("stores history on fulfilled", async () => {
      const history = [
        {
          section: "executive_summary" as const,
          version: 1,
          source: "sketch" as const,
          timestamp: "2025-01-01",
          diff: "old",
        },
      ];
      vi.mocked(api.prd.getHistory).mockResolvedValue(history as never);
      const store = createStore();
      await store.dispatch(fetchPrdHistory("proj-1"));

      expect(store.getState().spec.prdHistory).toEqual(history);
      expect(api.prd.getHistory).toHaveBeenCalledWith("proj-1");
    });

    it("uses empty array when data is null", async () => {
      vi.mocked(api.prd.getHistory).mockResolvedValue(null as never);
      const store = createStore();
      await store.dispatch(fetchPrdHistory("proj-1"));

      expect(store.getState().spec.prdHistory).toEqual([]);
    });
  });

  describe("sendSpecMessage thunk", () => {
    it("sets sendingChat true on pending", async () => {
      let resolveApi: (v: { message: string }) => void;
      const apiPromise = new Promise<{ message: string }>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.chat.send).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        sendSpecMessage({ projectId: "proj-1", message: "Hello" }),
      );

      expect(store.getState().spec.sendingChat).toBe(true);
      expect(store.getState().spec.error).toBeNull();

      resolveApi!({ message: "Response" });
      await dispatchPromise;
    });

    it("appends assistant message and clears sendingChat on fulfilled", async () => {
      vi.mocked(api.chat.send).mockResolvedValue({ message: "Here is my response" } as never);
      const store = createStore();
      await store.dispatch(
        sendSpecMessage({ projectId: "proj-1", message: "hello" }),
      );

      const state = store.getState().spec;
      expect(state.sendingChat).toBe(false);
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].role).toBe("assistant");
      expect(state.messages[0].content).toBe("Here is my response");
      expect(api.chat.send).toHaveBeenCalledWith("proj-1", "hello", "sketch", undefined);
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.chat.send).mockRejectedValue(new Error("Send failed"));
      const store = createStore();
      await store.dispatch(
        sendSpecMessage({ projectId: "proj-1", message: "hello" }),
      );

      expect(store.getState().spec.sendingChat).toBe(false);
      expect(store.getState().spec.error).toBe("Send failed");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.chat.send).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(
        sendSpecMessage({ projectId: "proj-1", message: "hello" }),
      );

      expect(store.getState().spec.error).toBe("Failed to send message");
    });
  });

  describe("savePrdSection thunk", () => {
    it("adds section to savingSections on pending", async () => {
      let resolveApi: () => void;
      const apiPromise = new Promise<void>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.prd.updateSection).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        savePrdSection({ projectId: "proj-1", section: "overview", content: "New content" }),
      );

      expect(store.getState().spec.savingSections).toContain("overview");

      resolveApi!();
      await dispatchPromise;
    });

    it("removes section from savingSections on fulfilled", async () => {
      vi.mocked(api.prd.updateSection).mockResolvedValue(undefined as never);
      const store = createStore();
      await store.dispatch(
        savePrdSection({ projectId: "proj-1", section: "overview", content: "Content" }),
      );

      expect(store.getState().spec.savingSections).not.toContain("overview");
      expect(api.prd.updateSection).toHaveBeenCalledWith("proj-1", "overview", "Content");
    });

    it("removes section from savingSections and sets error on rejected", async () => {
      vi.mocked(api.prd.updateSection).mockRejectedValue(new Error("Save failed"));
      const store = createStore();
      await store.dispatch(
        savePrdSection({ projectId: "proj-1", section: "overview", content: "Content" }),
      );

      expect(store.getState().spec.savingSections).not.toContain("overview");
      expect(store.getState().spec.error).toBe("Save failed");
    });
  });

  describe("uploadPrdFile thunk", () => {
    it("sends chat for .md file and appends message on fulfilled", async () => {
      vi.mocked(api.chat.send).mockResolvedValue({ message: "Parsed PRD" } as never);
      const store = createStore();
      const file = new File(["# PRD content"], "doc.md", { type: "text/markdown" });
      await store.dispatch(uploadPrdFile({ projectId: "proj-1", file }));

      const state = store.getState().spec;
      expect(state.sendingChat).toBe(false);
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe("Parsed PRD");
      expect(api.chat.send).toHaveBeenCalled();
    });

    it("sets sendingChat true on pending", async () => {
      let resolveApi: (v: { response: { message: string } | null; fileName: string }) => void;
      const apiPromise = new Promise<{ response: { message: string } | null; fileName: string }>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.chat.send).mockReturnValue(apiPromise as never);
      const store = createStore();
      const file = new File(["content"], "doc.md", { type: "text/markdown" });
      const dispatchPromise = store.dispatch(uploadPrdFile({ projectId: "proj-1", file }));

      expect(store.getState().spec.sendingChat).toBe(true);

      resolveApi!({ response: { message: "Done" }, fileName: "doc.md" });
      await dispatchPromise;
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.chat.send).mockRejectedValue(new Error("Upload failed"));
      const store = createStore();
      const file = new File(["content"], "doc.md", { type: "text/markdown" });
      await store.dispatch(uploadPrdFile({ projectId: "proj-1", file }));

      expect(store.getState().spec.sendingChat).toBe(false);
      expect(store.getState().spec.error).toBe("Upload failed");
    });

    it("throws for unsupported file type", async () => {
      const store = createStore();
      const file = new File(["content"], "doc.txt", { type: "text/plain" });
      const result = await store.dispatch(uploadPrdFile({ projectId: "proj-1", file }));

      expect(result.type).toBe("spec/uploadPrdFile/rejected");
    });
  });
});
