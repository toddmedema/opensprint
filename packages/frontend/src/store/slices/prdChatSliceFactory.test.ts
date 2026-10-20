import { describe, it, expect } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { createPrdChatSlice } from "./prdChatSliceFactory";

describe("createPrdChatSlice", () => {
  it("produces slice with correct name for sketch", () => {
    const { slice } = createPrdChatSlice("sketch");
    expect(slice.name).toBe("sketch");
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
    const spec = createPrdChatSlice("spec");

    const store = configureStore({
      reducer: {
        sketch: sketch.slice.reducer,
        spec: spec.slice.reducer,
      },
    });

    expect(store.getState().sketch).toBeDefined();
    expect(store.getState().spec).toBeDefined();
  });
});

describe("request ownership across reset", () => {
  it.each(["sendMessage", "uploadPrdFile"] as const)(
    "ignores obsolete %s success and error without clearing the current operation",
    (kind) => {
      const { slice, thunks } = createPrdChatSlice("sketch");
      const store = configureStore({ reducer: slice.reducer });
      const sendArgs = { projectId: "A", message: "hello" };
      const uploadArgs = { projectId: "A", file: new File(["PRD"], "prd.md") };
      const old =
        kind === "sendMessage"
          ? thunks.sendMessage.pending("old-A", sendArgs)
          : thunks.uploadPrdFile.pending("old-A", uploadArgs);
      store.dispatch(old);
      store.dispatch(slice.actions.reset(undefined as never));
      store.dispatch(thunks.sendMessage.pending("new-A", sendArgs));
      if (kind === "sendMessage") {
        store.dispatch(
          thunks.sendMessage.fulfilled({ message: "obsolete", prdChanges: [] }, "old-A", sendArgs)
        );
        store.dispatch(thunks.sendMessage.rejected(new Error("obsolete error"), "old-A", sendArgs));
      } else {
        store.dispatch(
          thunks.uploadPrdFile.fulfilled(
            { response: { message: "obsolete", prdChanges: [] }, fileName: "prd.md" },
            "old-A",
            uploadArgs
          )
        );
        store.dispatch(
          thunks.uploadPrdFile.rejected(new Error("obsolete error"), "old-A", uploadArgs)
        );
      }
      expect(store.getState().sendingChat).toBe(true);
      expect(store.getState().messages).toEqual([]);
      expect(store.getState().error).toBeNull();
      store.dispatch(
        thunks.sendMessage.fulfilled({ message: "current", prdChanges: [] }, "new-A", sendArgs)
      );
      expect(store.getState().messages.map((m) => m.content)).toEqual(["current"]);
      expect(store.getState().sendingChat).toBe(false);
    }
  );

  it("does not let a send overwrite a newer upload, or old fetch/save complete after reset", () => {
    const { slice, thunks } = createPrdChatSlice("sketch");
    const store = configureStore({ reducer: slice.reducer });
    const args = { projectId: "A", message: "hello" };
    const uploadArgs = { projectId: "B", file: new File(["PRD"], "prd.md") };
    store.dispatch(thunks.sendMessage.pending("send", args));
    store.dispatch(thunks.uploadPrdFile.pending("upload", uploadArgs));
    store.dispatch(thunks.sendMessage.rejected(new Error("old"), "send", args));
    expect(store.getState().sendingChat).toBe(true);
    store.dispatch(
      thunks.uploadPrdFile.fulfilled({ response: null, fileName: "prd.md" }, "upload", uploadArgs)
    );
    expect(store.getState().sendingChat).toBe(false);
    store.dispatch(thunks.fetchChat.pending("fetch", "A"));
    const save = { projectId: "A", section: "overview", content: "old" };
    store.dispatch(thunks.savePrdSection.pending("save", save));
    store.dispatch(slice.actions.reset(undefined as never));
    store.dispatch(
      thunks.fetchChat.fulfilled(
        [{ role: "assistant", content: "old", timestamp: "" }],
        "fetch",
        "A"
      )
    );
    store.dispatch(thunks.savePrdSection.rejected(new Error("old"), "save", save));
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().error).toBeNull();
  });
});
