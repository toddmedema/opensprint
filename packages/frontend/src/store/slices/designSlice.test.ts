import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import designReducer, {
  fetchDesignChat,
  fetchPrd,
  fetchPrdHistory,
  sendDesignMessage,
  savePrdSection,
  uploadPrdFile,
  addUserMessage,
  setDesignError,
  setPrdContent,
  setPrdHistory,
  resetDesign,
  type DesignState,
} from "./designSlice";

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

describe("designSlice", () => {
  beforeEach(() => {
    vi.mocked(api.chat.history).mockReset();
    vi.mocked(api.chat.send).mockReset();
    vi.mocked(api.prd.get).mockReset();
    vi.mocked(api.prd.getHistory).mockReset();
    vi.mocked(api.prd.updateSection).mockReset();
    vi.mocked(api.prd.upload).mockReset();
  });

  function createStore() {
    return configureStore({ reducer: { design: designReducer } });
  }

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = createStore();
      const state = store.getState().design as DesignState;
      expect(state.messages).toEqual([]);
      expect(state.prdContent).toEqual({});
      expect(state.prdHistory).toEqual([]);
      expect(state.sendingChat).toBe(false);
      expect(state.savingSections).toEqual([]);
      expect(state.error).toBeNull();
    });
  });

  describe("reducers", () => {
    it("resetDesign resets state to initial values", () => {
      const store = createStore();
      store.dispatch(addUserMessage({ role: "user", content: "hi", timestamp: "2025-01-01" }));
      store.dispatch(setPrdContent({ overview: "test" }));
      expect(store.getState().design.messages).toHaveLength(1);
      expect(store.getState().design.prdContent).toEqual({ overview: "test" });

      store.dispatch(resetDesign());
      const state = store.getState().design as DesignState;
      expect(state.messages).toEqual([]);
      expect(state.prdContent).toEqual({});
      expect(state.prdHistory).toEqual([]);
      expect(state.sendingChat).toBe(false);
      expect(state.savingSections).toEqual([]);
      expect(state.error).toBeNull();
    });

    it("addUserMessage appends message", () => {
      const store = createStore();
      store.dispatch(addUserMessage({ role: "user", content: "hello", timestamp: "2025-01-01" }));
      expect(store.getState().design.messages).toEqual([
        { role: "user", content: "hello", timestamp: "2025-01-01" },
      ]);
    });

    it("setDesignError sets error", () => {
      const store = createStore();
      store.dispatch(setDesignError("Something went wrong"));
      expect(store.getState().design.error).toBe("Something went wrong");
      store.dispatch(setDesignError(null));
      expect(store.getState().design.error).toBeNull();
    });

    it("setPrdContent sets prdContent", () => {
      const store = createStore();
      store.dispatch(setPrdContent({ overview: "Overview text", goals: "Goals text" }));
      expect(store.getState().design.prdContent).toEqual({ overview: "Overview text", goals: "Goals text" });
    });

    it("setPrdHistory sets prdHistory", () => {
      const store = createStore();
      const history = [
        { section: "overview", version: 1, source: "sketch" as const, timestamp: "2025-01-01", diff: "+new" },
      ];
      store.dispatch(setPrdHistory(history));
      expect(store.getState().design.prdHistory).toEqual(history);
    });
  });

  describe("fetchDesignChat thunk", () => {
    it("stores messages on fulfilled", async () => {
      const messages = [
        { role: "user" as const, content: "hi", timestamp: "2025-01-01" },
        { role: "assistant" as const, content: "hello", timestamp: "2025-01-01" },
      ];
      vi.mocked(api.chat.history).mockResolvedValue({ messages });
      const store = createStore();
      await store.dispatch(fetchDesignChat("proj-1"));

      expect(store.getState().design.messages).toEqual(messages);
      expect(api.chat.history).toHaveBeenCalledWith("proj-1", "sketch");
    });

    it("uses empty array when messages missing", async () => {
      vi.mocked(api.chat.history).mockResolvedValue({});
      const store = createStore();
      await store.dispatch(fetchDesignChat("proj-2"));

      expect(store.getState().design.messages).toEqual([]);
    });
  });

  describe("fetchPrd thunk", () => {
    it("parses and stores prd sections on fulfilled", async () => {
      vi.mocked(api.prd.get).mockResolvedValue({
        sections: {
          overview: { content: "Overview content" },
          goals: { content: "Goals content" },
        },
      });
      const store = createStore();
      await store.dispatch(fetchPrd("proj-1"));

      expect(store.getState().design.prdContent).toEqual({
        overview: "Overview content",
        goals: "Goals content",
      });
      expect(api.prd.get).toHaveBeenCalledWith("proj-1");
    });

    it("stores empty object when no sections", async () => {
      vi.mocked(api.prd.get).mockResolvedValue({});
      const store = createStore();
      await store.dispatch(fetchPrd("proj-1"));

      expect(store.getState().design.prdContent).toEqual({});
    });
  });

  describe("fetchPrdHistory thunk", () => {
    it("stores history on fulfilled", async () => {
      const history = [
        { section: "overview", version: 1, source: "sketch" as const, timestamp: "2025-01-01", diff: "+new" },
      ];
      vi.mocked(api.prd.getHistory).mockResolvedValue(history);
      const store = createStore();
      await store.dispatch(fetchPrdHistory("proj-1"));

      expect(store.getState().design.prdHistory).toEqual(history);
      expect(api.prd.getHistory).toHaveBeenCalledWith("proj-1");
    });

    it("stores empty array when null/undefined", async () => {
      vi.mocked(api.prd.getHistory).mockResolvedValue(null);
      const store = createStore();
      await store.dispatch(fetchPrdHistory("proj-1"));

      expect(store.getState().design.prdHistory).toEqual([]);
    });
  });

  describe("sendDesignMessage thunk", () => {
    it("sets sendingChat true on pending", async () => {
      let resolveApi: (v: { message: string }) => void;
      const apiPromise = new Promise<{ message: string }>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.chat.send).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        sendDesignMessage({ projectId: "proj-1", message: "hello" }),
      );

      expect(store.getState().design.sendingChat).toBe(true);
      expect(store.getState().design.error).toBeNull();

      resolveApi!({ message: "Response" });
      await dispatchPromise;
    });

    it("appends assistant message and clears sendingChat on fulfilled", async () => {
      vi.mocked(api.chat.send).mockResolvedValue({ message: "Here is my response" });
      const store = createStore();
      await store.dispatch(sendDesignMessage({ projectId: "proj-1", message: "hello" }));

      const state = store.getState().design;
      expect(state.sendingChat).toBe(false);
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].role).toBe("assistant");
      expect(state.messages[0].content).toBe("Here is my response");
      expect(api.chat.send).toHaveBeenCalledWith("proj-1", "hello", "sketch", undefined);
    });

    it("passes prdSectionFocus when provided", async () => {
      vi.mocked(api.chat.send).mockResolvedValue({ message: "ok" });
      const store = createStore();
      await store.dispatch(
        sendDesignMessage({ projectId: "proj-1", message: "edit overview", prdSectionFocus: "overview" }),
      );

      expect(api.chat.send).toHaveBeenCalledWith("proj-1", "edit overview", "sketch", "overview");
    });

    it("sets error and clears sendingChat on rejected", async () => {
      vi.mocked(api.chat.send).mockRejectedValue(new Error("Network error"));
      const store = createStore();
      await store.dispatch(sendDesignMessage({ projectId: "proj-1", message: "hello" }));

      const state = store.getState().design;
      expect(state.sendingChat).toBe(false);
      expect(state.error).toBe("Network error");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.chat.send).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(sendDesignMessage({ projectId: "proj-1", message: "hello" }));

      expect(store.getState().design.error).toBe("Failed to send message");
    });
  });

  describe("savePrdSection thunk", () => {
    it("sets savingSections on pending", async () => {
      let resolveApi: () => void;
      const apiPromise = new Promise<void>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.prd.updateSection).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        savePrdSection({ projectId: "proj-1", section: "overview", content: "New content" }),
      );

      expect(store.getState().design.savingSections).toContain("overview");

      resolveApi!();
      await dispatchPromise;
    });

    it("clears savingSections on fulfilled", async () => {
      vi.mocked(api.prd.updateSection).mockResolvedValue(undefined);
      const store = createStore();
      await store.dispatch(
        savePrdSection({ projectId: "proj-1", section: "goals", content: "Updated goals" }),
      );

      expect(store.getState().design.savingSections).toEqual([]);
      expect(api.prd.updateSection).toHaveBeenCalledWith("proj-1", "goals", "Updated goals");
    });

    it("clears savingSections and sets error on rejected", async () => {
      vi.mocked(api.prd.updateSection).mockRejectedValue(new Error("Save failed"));
      const store = createStore();
      await store.dispatch(
        savePrdSection({ projectId: "proj-1", section: "overview", content: "content" }),
      );

      const state = store.getState().design;
      expect(state.savingSections).toEqual([]);
      expect(state.error).toBe("Save failed");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.prd.updateSection).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(
        savePrdSection({ projectId: "proj-1", section: "overview", content: "content" }),
      );

      expect(store.getState().design.error).toBe("Failed to save PRD section");
    });

    it("allows concurrent saves for different sections", async () => {
      let resolveA: () => void;
      let resolveB: () => void;
      const promiseA = new Promise<void>((r) => {
        resolveA = r;
      });
      const promiseB = new Promise<void>((r) => {
        resolveB = r;
      });
      vi.mocked(api.prd.updateSection)
        .mockImplementationOnce(() => promiseA as never)
        .mockImplementationOnce(() => promiseB as never);
      const store = createStore();

      store.dispatch(savePrdSection({ projectId: "proj-1", section: "overview", content: "A" }));
      store.dispatch(savePrdSection({ projectId: "proj-1", section: "goals", content: "B" }));

      expect(store.getState().design.savingSections).toContain("overview");
      expect(store.getState().design.savingSections).toContain("goals");

      resolveA!();
      resolveB!();
      await Promise.all([promiseA, promiseB]);

      expect(store.getState().design.savingSections).toEqual([]);
    });
  });

  describe("uploadPrdFile thunk", () => {
    it("sends .md file content via chat and appends assistant message on fulfilled", async () => {
      const file = new File(["# My PRD\n\nContent"], "doc.md", { type: "text/markdown" });
      vi.mocked(api.chat.send).mockResolvedValue({ message: "Parsed your PRD" });
      const store = createStore();
      await store.dispatch(uploadPrdFile({ projectId: "proj-1", file }));

      expect(api.chat.send).toHaveBeenCalledWith(
        "proj-1",
        expect.stringContaining("# My PRD"),
        "sketch",
        undefined,
      );
      const state = store.getState().design;
      expect(state.sendingChat).toBe(false);
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].role).toBe("assistant");
      expect(state.messages[0].content).toBe("Parsed your PRD");
    });

    it("sets sendingChat true on pending", async () => {
      const file = new File(["content"], "doc.md", { type: "text/markdown" });
      let resolveApi: (v: { message: string }) => void;
      const apiPromise = new Promise<{ message: string }>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.chat.send).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(uploadPrdFile({ projectId: "proj-1", file }));

      expect(store.getState().design.sendingChat).toBe(true);
      resolveApi!({ message: "ok" });
      await dispatchPromise;
    });

    it("sets error on rejected", async () => {
      const file = new File(["content"], "doc.md", { type: "text/markdown" });
      vi.mocked(api.chat.send).mockRejectedValue(new Error("Upload failed"));
      const store = createStore();
      await store.dispatch(uploadPrdFile({ projectId: "proj-1", file }));

      expect(store.getState().design.sendingChat).toBe(false);
      expect(store.getState().design.error).toBe("Upload failed");
    });
  });
});
