import React from "react";
import { render } from "@testing-library/react";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import type { Store } from "@reduxjs/toolkit";
import { type RootState } from "../store";
import projectReducer from "../store/slices/projectSlice";
import globalReducer from "../store/slices/globalSlice";
import websocketReducer from "../store/slices/websocketSlice";
import connectionReducer from "../store/slices/connectionSlice";
import sketchReducer from "../store/slices/sketchSlice";
import planReducer from "../store/slices/planSlice";
import executeReducer from "../store/slices/executeSlice";
import evalReducer from "../store/slices/evalSlice";
import deliverReducer from "../store/slices/deliverSlice";
import notificationReducer from "../store/slices/notificationSlice";
import openQuestionsReducer from "../store/slices/openQuestionsSlice";

function createTestStore(preloadedState?: Partial<RootState>): Store {
  return configureStore({
    reducer: {
      project: projectReducer,
      global: globalReducer,
      websocket: websocketReducer,
      connection: connectionReducer,
      sketch: sketchReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      deliver: deliverReducer,
      notification: notificationReducer,
      openQuestions: openQuestionsReducer,
    },
    preloadedState: preloadedState as Record<string, unknown> | undefined,
  }) as Store;
}

const defaultQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

export interface RenderWithProvidersOptions {
  store?: Store;
  queryClient?: QueryClient;
  preloadedState?: Partial<RootState>;
}

/**
 * Renders UI with QueryClientProvider and Redux Provider for tests.
 * Uses createTestStore() by default (no app middleware). Pass store or preloadedState to customize.
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options: RenderWithProvidersOptions = {}
) {
  const store =
    options.store ?? createTestStore(options.preloadedState);
  const queryClient = options.queryClient ?? defaultQueryClient;

  return render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{ui}</Provider>
    </QueryClientProvider>
  );
}

/** Wraps ui with the same providers; use with render().rerender() when you need the same store. */
export function wrapWithProviders(
  ui: React.ReactElement,
  options: { store: Store; queryClient?: QueryClient }
) {
  const queryClient = options.queryClient ?? defaultQueryClient;
  return (
    <QueryClientProvider client={queryClient}>
      <Provider store={options.store}>{ui}</Provider>
    </QueryClientProvider>
  );
}

export { render };
export { createTestStore };
export type { RootState };
