import React from "react";
import { render } from "@testing-library/react";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import type { Store, Middleware } from "@reduxjs/toolkit";
import { MemoryRouter } from "react-router-dom";
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
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { seedServerFixtureFromElement } from "./seedServerFixtures";
import { setQueryClient } from "../queryClient";

function createTestStore(
  preloadedState?: Partial<RootState>,
  extraMiddleware: Middleware[] = []
): Store {
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
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(...extraMiddleware),
  }) as Store;
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

export interface RenderWithProvidersOptions {
  store?: Store;
  queryClient?: QueryClient;
  preloadedState?: Partial<RootState>;
}

export interface RenderAppOptions extends RenderWithProvidersOptions {
  routeEntries?: string[];
}

function AppProviders({
  children,
  store,
  queryClient,
  routeEntries,
}: {
  children: React.ReactNode;
  store: Store;
  queryClient: QueryClient;
  routeEntries: string[];
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={store}>
            <MemoryRouter initialEntries={routeEntries}>{children}</MemoryRouter>
          </Provider>
        </DisplayPreferencesProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/**
 * Renders UI with QueryClientProvider and Redux Provider for tests.
 * Uses createTestStore() by default (no app middleware). Pass store or preloadedState to customize.
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options: RenderWithProvidersOptions = {}
) {
  const store = options.store ?? createTestStore(options.preloadedState);
  const queryClient = options.queryClient ?? createTestQueryClient();
  setQueryClient(queryClient);
  seedServerFixtureFromElement(queryClient, <Provider store={store}>{ui}</Provider>);

  return render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{ui}</Provider>
    </QueryClientProvider>
  );
}

/** Renders the app with all runtime providers used by routed pages/components. */
export function renderApp(ui: React.ReactElement, options: RenderAppOptions = {}) {
  const store = options.store ?? createTestStore(options.preloadedState);
  const queryClient = options.queryClient ?? createTestQueryClient();
  setQueryClient(queryClient);
  const routeEntries = options.routeEntries ?? ["/"];
  seedServerFixtureFromElement(queryClient, <Provider store={store}>{ui}</Provider>);

  return render(
    <AppProviders store={store} queryClient={queryClient} routeEntries={routeEntries}>
      {ui}
    </AppProviders>
  );
}

/** Wraps ui with the same providers; use with render().rerender() when you need the same store. */
export function wrapWithProviders(
  ui: React.ReactElement,
  options: { store: Store; queryClient?: QueryClient }
) {
  const queryClient = options.queryClient ?? createTestQueryClient();
  setQueryClient(queryClient);
  seedServerFixtureFromElement(queryClient, <Provider store={options.store}>{ui}</Provider>);
  return (
    <QueryClientProvider client={queryClient}>
      <Provider store={options.store}>{ui}</Provider>
    </QueryClientProvider>
  );
}

/** Wraps ui with the full runtime provider stack for rerender-heavy app tests. */
export function wrapApp(
  ui: React.ReactElement,
  options: { store: Store; queryClient?: QueryClient; routeEntries?: string[] }
) {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const routeEntries = options.routeEntries ?? ["/"];
  return (
    <AppProviders store={options.store} queryClient={queryClient} routeEntries={routeEntries}>
      {ui}
    </AppProviders>
  );
}

/** Mobile viewport (iPhone SE). */
export const VIEWPORT_MOBILE = { width: 375, height: 667 };
/** Tablet viewport (iPad). */
export const VIEWPORT_TABLET = { width: 768, height: 1024 };

/**
 * Mocks window.innerWidth/innerHeight for viewport-dependent tests.
 * Call the returned restore function in afterEach or after the test.
 */
export function mockViewport(width: number, height = 667): () => void {
  const origWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const origHeight = typeof window !== "undefined" ? window.innerHeight : 768;
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "innerWidth", {
      value: width,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: height,
      writable: true,
      configurable: true,
    });
  }
  return () => {
    if (typeof window !== "undefined") {
      Object.defineProperty(window, "innerWidth", {
        value: origWidth,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: origHeight,
        writable: true,
        configurable: true,
      });
    }
  };
}

export { render };
export { createTestStore };
export type { RootState };
