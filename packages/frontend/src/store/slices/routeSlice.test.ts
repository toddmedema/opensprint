import { describe, it, expect } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import routeReducer, { setRoute } from "./routeSlice";

function createStore(
  preloadedState?: { route?: { projectId: string | null; phase: "plan" | "sketch" | "execute" | "eval" | "deliver" | null } }
) {
  return configureStore({
    reducer: { route: routeReducer },
    preloadedState,
  });
}

describe("routeSlice", () => {
  it("initial state has projectId and phase null", () => {
    const store = createStore();
    expect(store.getState().route.projectId).toBeNull();
    expect(store.getState().route.phase).toBeNull();
  });

  it("setRoute sets projectId and phase", () => {
    const store = createStore();
    store.dispatch(setRoute({ projectId: "foo", phase: "plan" }));
    expect(store.getState().route.projectId).toBe("foo");
    expect(store.getState().route.phase).toBe("plan");
  });

  it("setRoute with phase null (e.g. settings) keeps projectId", () => {
    const store = createStore();
    store.dispatch(setRoute({ projectId: "foo", phase: "plan" }));
    store.dispatch(setRoute({ projectId: "foo", phase: null }));
    expect(store.getState().route.projectId).toBe("foo");
    expect(store.getState().route.phase).toBeNull();
  });

  it("setRoute clears both when navigating away", () => {
    const store = createStore();
    store.dispatch(setRoute({ projectId: "foo", phase: "execute" }));
    store.dispatch(setRoute({ projectId: null, phase: null }));
    expect(store.getState().route.projectId).toBeNull();
    expect(store.getState().route.phase).toBeNull();
  });

  it("setRoute updates phase when navigating between phases", () => {
    const store = createStore();
    store.dispatch(setRoute({ projectId: "proj-1", phase: "sketch" }));
    expect(store.getState().route.phase).toBe("sketch");
    store.dispatch(setRoute({ projectId: "proj-1", phase: "plan" }));
    expect(store.getState().route.phase).toBe("plan");
    store.dispatch(setRoute({ projectId: "proj-1", phase: "execute" }));
    expect(store.getState().route.phase).toBe("execute");
    store.dispatch(setRoute({ projectId: "proj-1", phase: "eval" }));
    expect(store.getState().route.phase).toBe("eval");
    store.dispatch(setRoute({ projectId: "proj-1", phase: "deliver" }));
    expect(store.getState().route.phase).toBe("deliver");
  });

  it("sync from ProjectShell: navigating to /projects/foo/plan updates store to projectId=foo, phase=plan", () => {
    const store = createStore();
    store.dispatch(setRoute({ projectId: "foo", phase: "plan" }));
    expect(store.getState().route.projectId).toBe("foo");
    expect(store.getState().route.phase).toBe("plan");
  });

  it("sync from ProjectShell: navigating to /projects/foo/settings updates to phase=null", () => {
    const store = createStore();
    store.dispatch(setRoute({ projectId: "foo", phase: "sketch" }));
    store.dispatch(setRoute({ projectId: "foo", phase: null }));
    expect(store.getState().route.projectId).toBe("foo");
    expect(store.getState().route.phase).toBeNull();
  });
});
