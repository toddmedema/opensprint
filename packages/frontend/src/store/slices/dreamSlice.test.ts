/**
 * @deprecated dreamSlice is a re-export of specSlice. Use specSlice.test.ts for full coverage.
 * This file verifies the deprecated dreamSlice re-exports work correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import dreamReducer, {
  fetchDreamChat,
  sendDreamMessage,
  setPrdHistory,
  type DreamState,
} from "./dreamSlice";

vi.mock("../../api/client", () => ({
  api: {
    chat: {
      history: vi.fn(),
      send: vi.fn(),
    },
    prd: { get: vi.fn(), getHistory: vi.fn(), updateSection: vi.fn(), upload: vi.fn() },
  },
}));

import { api } from "../../api/client";

describe("dreamSlice (deprecated re-export of specSlice)", () => {
  beforeEach(() => {
    vi.mocked(api.chat.history).mockReset();
    vi.mocked(api.chat.send).mockReset();
  });

  it("fetchDreamChat delegates to api.chat.history with sketch context", async () => {
    vi.mocked(api.chat.history).mockResolvedValue({ messages: [] } as never);
    const store = configureStore({ reducer: { dream: dreamReducer } });
    await store.dispatch(fetchDreamChat("proj-1"));
    expect(api.chat.history).toHaveBeenCalledWith("proj-1", "sketch");
  });

  it("sendDreamMessage delegates to api.chat.send with sketch context", async () => {
    vi.mocked(api.chat.send).mockResolvedValue({ message: "OK" } as never);
    const store = configureStore({ reducer: { dream: dreamReducer } });
    await store.dispatch(sendDreamMessage({ projectId: "proj-1", message: "hi" }));
    expect(api.chat.send).toHaveBeenCalledWith("proj-1", "hi", "sketch", undefined);
  });

  it("setPrdHistory accepts PrdChangeLogEntry with source sketch", () => {
    const history = [
      {
        section: "executive_summary" as const,
        version: 1,
        source: "sketch" as const,
        timestamp: "2025-01-01",
        diff: "old",
      },
    ];
    const store = configureStore({ reducer: { dream: dreamReducer } });
    store.dispatch(setPrdHistory(history as never));
    const state = store.getState().dream as DreamState;
    expect(state.prdHistory).toEqual(history);
    expect(state.prdHistory[0].source).toBe("sketch");
  });
});
