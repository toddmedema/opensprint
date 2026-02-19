import { describe, it, expect } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { createPrdChatSlice } from "./prdChatSliceFactory";

describe("createPrdChatSlice", () => {
  it("produces slice with correct name for sketch", () => {
    const { slice } = createPrdChatSlice("sketch");
    expect(slice.name).toBe("sketch");
  });

  it("produces slice with correct name for design", () => {
    const { slice } = createPrdChatSlice("design");
    expect(slice.name).toBe("design");
  });

  it("produces thunks with correct action type prefixes", () => {
    const { thunks } = createPrdChatSlice("spec");
    expect(thunks.fetchChat.typePrefix).toBe("spec/fetchChat");
    expect(thunks.sendMessage.typePrefix).toBe("spec/sendMessage");
    expect(thunks.savePrdSection.typePrefix).toBe("spec/savePrdSection");
    expect(thunks.uploadPrdFile.typePrefix).toBe("spec/uploadPrdFile");
  });

  it("produces independent slices per name", () => {
    const sketch = createPrdChatSlice("sketch");
    const design = createPrdChatSlice("design");

    const store = configureStore({
      reducer: {
        sketch: sketch.slice.reducer,
        design: design.slice.reducer,
      },
    });

    expect(store.getState().sketch).toBeDefined();
    expect(store.getState().design).toBeDefined();
  });
});
