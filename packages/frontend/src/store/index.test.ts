import { describe, it, expect } from "vitest";
import { store } from "./index";
import type { RootState } from "./index";

describe("store", () => {
  it("has project and websocket slices registered", () => {
    const state = store.getState() as RootState;
    expect(state).toHaveProperty("project");
    expect(state).toHaveProperty("websocket");
  });

  it("project slice has expected shape", () => {
    const state = store.getState() as RootState;
    expect(state.project).toMatchObject({
      data: null,
      loading: false,
      error: null,
    });
  });

  it("websocket slice has expected shape", () => {
    const state = store.getState() as RootState;
    expect(state.websocket).toMatchObject({
      connected: false,
      hilRequest: null,
      hilNotification: null,
    });
  });
});
