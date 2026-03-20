// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { configureStore } from "@reduxjs/toolkit";
import { SketchPhase } from "./SketchPhase";
import { EMPTY_STATE_COPY } from "../../lib/emptyStateCopy";
import { queryKeys } from "../../api/queryKeys";
import sketchReducer from "../../store/slices/sketchSlice";
import planReducer from "../../store/slices/planSlice";
import unreadPhaseReducer, { setPhaseUnread } from "../../store/slices/unreadPhaseSlice";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () =>
      ({
        top: 500,
        left: 500,
        right: 600,
        bottom: 520,
        width: 100,
        height: 20,
        x: 500,
        y: 500,
        toJSON: () => {},
      }) as DOMRect;
  }
});

const mockChatSend = vi.fn();
const mockChatHistory = vi.fn();
const mockPrdGet = vi.fn();
const mockPrdGetHistory = vi.fn();
const mockPrdUpdateSection = vi.fn();
const mockPrdUpload = vi.fn();
const mockPrdGenerateFromCodebase = vi.fn();
const mockPrdGetVersionDiff = vi.fn();
const mockPlansDecompose = vi.fn();
const mockRefetchNotifications = vi.fn();
const mockGetSketchContext = vi.fn();
let mockOpenQuestionNotifications: unknown[] = [];

vi.mock("../../hooks/useOpenQuestionNotifications", () => ({
  useOpenQuestionNotifications: () => ({
    notifications: mockOpenQuestionNotifications,
    refetch: mockRefetchNotifications,
  }),
}));
let mockViewportWidth = 1024;
vi.mock("../../hooks/useViewportWidth", () => ({
  useViewportWidth: () => mockViewportWidth,
}));
vi.mock("../../hooks/usePhaseLoadingState", () => ({
  usePhaseLoadingState: (isLoading: boolean, isEmpty: boolean) => ({
    showSpinner: isLoading,
    showEmptyState: !isLoading && isEmpty,
  }),
}));
vi.mock("../../components/prd/PrdSectionEditor", () => ({
  PrdSectionEditor: ({
    sectionKey,
    markdown,
    onSave,
  }: {
    sectionKey: string;
    markdown: string;
    onSave: (s: string, m: string) => void;
  }) => (
    <div data-testid={`prd-editor-${sectionKey}`}>
      <span data-testid={`prd-content-${sectionKey}`}>{markdown}</span>
      <input
        data-testid={`prd-input-${sectionKey}`}
        defaultValue={markdown}
        onChange={(e) => onSave(sectionKey, e.target.value)}
      />
    </div>
  ),
}));

const mockGetPlanStatus = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    chat: {
      send: (...args: unknown[]) => mockChatSend(...args),
      history: (...args: unknown[]) => mockChatHistory(...args),
    },
    prd: {
      get: (...args: unknown[]) => mockPrdGet(...args),
      getHistory: (...args: unknown[]) => mockPrdGetHistory(...args),
      getVersionDiff: (...args: unknown[]) => mockPrdGetVersionDiff(...args),
      updateSection: (...args: unknown[]) => mockPrdUpdateSection(...args),
      upload: (...args: unknown[]) => mockPrdUpload(...args),
      generateFromCodebase: (...args: unknown[]) => mockPrdGenerateFromCodebase(...args),
    },
    plans: {
      decompose: (...args: unknown[]) => mockPlansDecompose(...args),
    },
    projects: {
      getPlanStatus: (...args: unknown[]) => mockGetPlanStatus(...args),
      getSketchContext: (...args: unknown[]) => mockGetSketchContext(...args),
    },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
    },
  },
  isApiError: (err: unknown) => !!err && typeof err === "object" && "code" in (err as object),
}));

function createStore(preloadedState?: {
  sketch?: {
    messages?: { role: "user" | "assistant"; content: string; timestamp: string }[];
    prdContent?: Record<string, string>;
    prdHistory?: unknown[];
  };
  plan?: { planStatus?: { action: "plan" | "replan" | "none" } };
}) {
  return configureStore({
    reducer: {
      sketch: sketchReducer,
      plan: planReducer,
      unreadPhase: unreadPhaseReducer,
    },
    preloadedState: {
      sketch: {
        messages: preloadedState?.sketch?.messages ?? [],
        prdContent: preloadedState?.sketch?.prdContent ?? {},
        prdHistory: preloadedState?.sketch?.prdHistory ?? [],
        sendingChat: false,
        savingSections: [],
        error: null,
      },
      plan: {
        plans: [],
        dependencyGraph: null,
        selectedPlanId: null,
        chatMessages: {},
        loading: false,
        decomposing: false,
        planStatus: preloadedState?.plan?.planStatus ?? null,
        executingPlanId: null,
        reExecutingPlanId: null,
        archivingPlanId: null,
        error: null,
        backgroundError: null,
      },
    },
  });
}

function renderSketchPhase(store = createStore()) {
  const state = store.getState() as {
    sketch: {
      messages: { role: "user" | "assistant"; content: string; timestamp: string }[];
      prdContent: Record<string, string>;
      prdHistory: unknown[];
    };
    plan: {
      plans: unknown[];
      planStatus: { action: "plan" | "replan" | "none" } | null;
    };
  };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(queryKeys.prd.detail("proj-1"), state.sketch.prdContent);
  queryClient.setQueryData(queryKeys.prd.history("proj-1"), state.sketch.prdHistory);

  const wrappedUi = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Provider store={store}>
          <SketchPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const rendered = render(wrappedUi);

  return {
    ...rendered,
    rerender: () => rendered.rerender(wrappedUi),
    queryClient,
  };
}

describe("SketchPhase with sketchSlice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenQuestionNotifications = [];
    mockChatSend.mockResolvedValue({ message: "Response" });
    mockChatHistory.mockResolvedValue({ messages: [] });
    mockPrdGet.mockResolvedValue({ sections: {} });
    mockPrdGetHistory.mockResolvedValue([]);
    mockPrdUpdateSection.mockResolvedValue(undefined);
    mockPrdGenerateFromCodebase.mockResolvedValue(undefined);
    mockPlansDecompose.mockResolvedValue({ created: 2, plans: [] });
    mockGetSketchContext.mockResolvedValue({ hasExistingCode: false });
    mockGetPlanStatus.mockResolvedValue({
      hasPlanningRun: false,
      prdChangedSinceLastRun: false,
      action: "plan",
    });
  });

  it("clears sketch phase unread when mounted with projectId", () => {
    const store = createStore();
    store.dispatch(setPhaseUnread({ projectId: "proj-1", phase: "sketch" }));
    expect(store.getState().unreadPhase["proj-1"]?.sketch).toBe(true);

    act(() => {
      renderSketchPhase(store);
    });
    expect(store.getState().unreadPhase["proj-1"]?.sketch).toBeFalsy();
  });

  describe("initial prompt view (no PRD) — empty-state onboarding", () => {
    it("shows loading spinner until PRD state is known (prevents flash)", async () => {
      let resolvePrd: (v: unknown) => void;
      mockPrdGet.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePrd = resolve;
          })
      );

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0 } },
      });
      queryClient.setQueryData(queryKeys.prd.history("proj-1"), []);

      const wrappedUi = (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Provider store={createStore()}>
              <SketchPhase projectId="proj-1" />
            </Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      render(wrappedUi);

      expect(screen.getByTestId("sketch-phase-loading")).toBeInTheDocument();

      (resolvePrd as (v: unknown) => void)({ sections: {} });

      await waitFor(() => {
        expect(screen.getByText("What do you want to build?")).toBeInTheDocument();
      });
    });

    it("transitions from loading directly to PRD view when PRD exists (no flash of empty state)", async () => {
      let resolvePrd: (v: unknown) => void;
      mockPrdGet.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePrd = resolve;
          })
      );

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0 } },
      });
      queryClient.setQueryData(queryKeys.prd.history("proj-1"), []);

      const wrappedUi = (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Provider store={createStore()}>
              <SketchPhase projectId="proj-1" />
            </Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      render(wrappedUi);

      expect(screen.getByTestId("sketch-phase-loading")).toBeInTheDocument();
      expect(screen.queryByText("What do you want to build?")).not.toBeInTheDocument();
      expect(screen.queryByText("Product Requirements Document")).not.toBeInTheDocument();

      (resolvePrd as (v: unknown) => void)({
        sections: {
          executive_summary: { content: "Existing PRD summary", version: 1 },
        },
      });

      await waitFor(() => {
        expect(screen.getByText("Product Requirements Document")).toBeInTheDocument();
        expect(screen.getByTestId("prd-content-executive_summary")).toHaveTextContent(
          "Existing PRD summary"
        );
      });
      expect(screen.queryByTestId("sketch-phase-loading")).not.toBeInTheDocument();
      expect(screen.queryByText("What do you want to build?")).not.toBeInTheDocument();
    });

    it("renders central prompt when prdContent is empty", () => {
      renderSketchPhase();
      expect(screen.getByText("What do you want to build?")).toBeInTheDocument();
      expect(
        screen.getByText("Describe your app idea and Open Sprint will generate a PRD.")
      ).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("uses EMPTY_STATE_COPY for empty state title, description, and primary action", () => {
      renderSketchPhase();
      expect(screen.getByText(EMPTY_STATE_COPY.sketch.title)).toBeInTheDocument();
      expect(screen.getByText(EMPTY_STATE_COPY.sketch.description)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: EMPTY_STATE_COPY.sketch.primaryActionLabel })
      ).toBeInTheDocument();
    });

    it("renders file upload button in empty state", () => {
      renderSketchPhase();
      expect(screen.getByText("Upload existing PRD")).toBeInTheDocument();
      expect(screen.getByText(/.md, .docx, .pdf/)).toBeInTheDocument();
    });

    it("renders api_blocked notification inline in empty state", () => {
      mockOpenQuestionNotifications = [
        {
          id: "ab-1",
          projectId: "proj-1",
          source: "prd",
          sourceId: "global",
          status: "open",
          createdAt: "2026-03-03T00:00:00Z",
          resolvedAt: null,
          kind: "api_blocked",
          errorCode: "rate_limit",
          questions: [{ id: "q-1", text: "Google Gemini hit a rate limit", createdAt: "" }],
        },
      ];

      renderSketchPhase();

      expect(screen.getByText("API blocked")).toBeInTheDocument();
      expect(screen.getByText("Google Gemini hit a rate limit")).toBeInTheDocument();
    });

    it("prefers notification UX over sketchError for actionable generate-from-codebase failures", async () => {
      const user = userEvent.setup();
      mockPrdGenerateFromCodebase.mockRejectedValue({
        code: "AGENT_INVOKE_FAILED",
        message: "Google Gemini hit a rate limit",
      });
      mockGetSketchContext.mockResolvedValueOnce({ hasExistingCode: true });

      renderSketchPhase();

      await waitFor(() => {
        expect(screen.getByTestId("generate-from-codebase")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("generate-from-codebase"));

      await waitFor(() => {
        expect(mockRefetchNotifications).toHaveBeenCalled();
      });
      expect(screen.queryByText("Google Gemini hit a rate limit")).not.toBeInTheDocument();
    });

    it("dispatches sendSpecMessage when user submits initial idea", async () => {
      const user = userEvent.setup();
      const store = createStore();
      renderSketchPhase(store);

      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "A todo app");
      await user.click(screen.getByTestId("sketch-it-button"));

      await waitFor(() => {
        expect(mockChatSend).toHaveBeenCalledWith(
          "proj-1",
          "A todo app",
          "sketch",
          undefined,
          undefined
        );
      });
    });

    it("refetches PRD after Dreamer response so UI reflects PRD_UPDATE blocks", async () => {
      mockChatSend.mockResolvedValue({
        message: "Here is your PRD",
        prdChanges: [{ section: "executive_summary", previousVersion: 0, newVersion: 1 }],
      });
      mockPrdGet.mockResolvedValue({
        sections: { executive_summary: { content: "New content from Dreamer", version: 1 } },
      });

      const user = userEvent.setup();
      renderSketchPhase();

      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "A todo app with many features");
      await user.click(screen.getByTestId("sketch-it-button"));

      await waitFor(() => {
        expect(mockPrdGet).toHaveBeenCalledWith("proj-1");
      });
      expect(mockPrdGetHistory).toHaveBeenCalledWith("proj-1");
    });

    it("disables Sketch it button when input has fewer than 10 characters", async () => {
      const user = userEvent.setup();
      renderSketchPhase();
      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "short");
      expect(screen.getByTestId("sketch-it-button")).toBeDisabled();
      await user.type(textarea, " more"); // "short more" = 10 chars
      await waitFor(() => {
        expect(screen.getByTestId("sketch-it-button")).not.toBeDisabled();
      });
    });

    it("shows loading spinner in Sketch it button when sending", async () => {
      let resolveSend: (value: { message: string; prdChanges?: unknown[] }) => void;
      mockChatSend.mockImplementation(
        () =>
          new Promise((r) => {
            resolveSend = r;
          })
      );

      const user = userEvent.setup();
      renderSketchPhase();
      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "A todo app with many features");
      await user.click(screen.getByTestId("sketch-it-button"));

      await waitFor(() => {
        expect(screen.getByTestId("sketch-it-spinner")).toBeInTheDocument();
      });

      resolveSend!({ message: "Here is your PRD" });
    });

    it("empty state shows image attach button", () => {
      renderSketchPhase();
      expect(screen.getByTestId("sketch-attach-images")).toBeInTheDocument();
    });

    it("empty state shows animated typewriter placeholder that types and deletes example suggestions", async () => {
      vi.useFakeTimers();
      renderSketchPhase();
      const textarea = screen.getByRole("textbox");

      // Advance past first tick (40–80ms) — placeholder should have at least one character
      await vi.advanceTimersByTimeAsync(100);
      const initialPlaceholder = textarea.getAttribute("placeholder") ?? "";
      expect(initialPlaceholder.length).toBeGreaterThan(0);

      // Advance more — placeholder should grow (typing)
      await vi.advanceTimersByTimeAsync(500);
      const midPlaceholder = textarea.getAttribute("placeholder") ?? "";
      expect(midPlaceholder.length).toBeGreaterThanOrEqual(initialPlaceholder.length);

      vi.useRealTimers();
    });

    it("submits on Enter key (without Shift)", async () => {
      const user = userEvent.setup();
      renderSketchPhase();
      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "A fitness app");
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(mockChatSend).toHaveBeenCalledWith(
          "proj-1",
          "A fitness app",
          "sketch",
          undefined,
          undefined
        );
      });
    });

    it("shows Generating your PRD overlay when sending", async () => {
      let resolveSend: (value: { message: string; prdChanges?: unknown[] }) => void;
      mockChatSend.mockImplementation(
        () =>
          new Promise((r) => {
            resolveSend = r;
          })
      );

      const user = userEvent.setup();
      renderSketchPhase();
      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "A todo app");
      await user.click(screen.getByTestId("sketch-it-button"));

      await waitFor(() => {
        expect(screen.getByText("Generating your PRD...")).toBeInTheDocument();
        expect(
          screen.getByText(
            /This may take a moment while Open Sprint crafts your product requirements/
          )
        ).toBeInTheDocument();
      });

      resolveSend!({ message: "Here is your PRD" });
    });

    it("dispatches uploadPrdFile and fetchPrd when user uploads .md file", async () => {
      mockChatSend.mockResolvedValue({ message: "Parsed your PRD", prdChanges: [] });
      mockPrdGet.mockResolvedValue({
        sections: { executive_summary: { content: "Summary", version: 1 } },
      });

      const user = userEvent.setup();
      renderSketchPhase();

      const file = new File(["# My PRD\n\nContent here"], "sketch.md", { type: "text/markdown" });
      const fileInput = screen.getByTestId("prd-upload-input");

      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(mockChatSend).toHaveBeenCalledWith(
          "proj-1",
          expect.stringContaining("Here's my existing product requirements document"),
          "sketch"
        );
      });

      await waitFor(() => {
        expect(mockPrdGet).toHaveBeenCalledWith("proj-1");
      });
    });

    it("disables submit and upload when sending", async () => {
      let resolveSend: (value: { message: string }) => void;
      mockChatSend.mockImplementation(
        () =>
          new Promise((r) => {
            resolveSend = r;
          })
      );

      const user = userEvent.setup();
      renderSketchPhase();
      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "A todo app");
      await user.click(screen.getByTestId("sketch-it-button"));

      await waitFor(() => {
        expect(screen.getByTestId("sketch-it-button")).toBeDisabled();
        expect(screen.getByText("Upload existing PRD").closest("button")).toBeDisabled();
      });

      resolveSend!({ message: "Done" });
    });

    it("stores error in Redux when sendSpecMessage fails", async () => {
      mockChatSend.mockRejectedValue(new Error("Agent unavailable"));

      const store = createStore();
      const user = userEvent.setup();
      renderSketchPhase(store);
      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "A todo app");
      await user.click(screen.getByTestId("sketch-it-button"));

      await waitFor(() => {
        const state = store.getState();
        expect(state.sketch.error).toBe("Agent unavailable");
      });
    });
  });

  describe("PRD document view", () => {
    it("renders PRD sections when prdContent exists", () => {
      const store = createStore({
        sketch: {
          prdContent: {
            executive_summary: "Summary text",
            goals_and_metrics: "Goals text",
          },
        },
      });
      renderSketchPhase(store);

      expect(screen.getByText("Product Requirements Document")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Executive Summary" })).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Goals and Success Metrics" })
      ).toBeInTheDocument();
      expect(screen.getByTestId("prd-content-executive_summary")).toHaveTextContent("Summary text");
      expect(screen.getByTestId("prd-content-goals_and_metrics")).toHaveTextContent("Goals text");
    });

    it("dispatches savePrdSection when user edits section (debounced autosave)", async () => {
      const user = userEvent.setup();
      const store = createStore({
        sketch: { prdContent: { overview: "Original content" } },
      });
      renderSketchPhase(store);

      const input = screen.getByTestId("prd-input-overview");
      await user.clear(input);
      await user.type(input, "Updated content");

      await waitFor(() => {
        expect(mockPrdUpdateSection).toHaveBeenLastCalledWith(
          "proj-1",
          "overview",
          "Updated content"
        );
      });
    });

    it("displays chat and messages in split-pane when PRD exists", () => {
      const store = createStore({
        sketch: {
          prdContent: { overview: "Content" },
          messages: [
            { role: "user", content: "Hello", timestamp: "2025-01-01" },
            { role: "assistant", content: "Hi there!", timestamp: "2025-01-01" },
          ],
        },
      });
      renderSketchPhase(store);

      // Chat is always visible in split-pane (right pane)
      expect(screen.getByTestId("prd-chat-sidebar")).toBeInTheDocument();
      expect(screen.getByText("Hello")).toBeInTheDocument();
      expect(screen.getByText("Hi there!")).toBeInTheDocument();
    });

    it("loads Sketch chat history on mount when PRD exists (persistence across refresh)", async () => {
      mockChatHistory.mockResolvedValue({
        messages: [
          { role: "user", content: "Hello", timestamp: "2025-01-01" },
          { role: "assistant", content: "Hi there!", timestamp: "2025-01-01" },
        ],
      });
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
      });
      renderSketchPhase(store);

      await waitFor(() => {
        expect(mockChatHistory).toHaveBeenCalledWith("proj-1", "sketch");
        expect(screen.getByText("Hello")).toBeInTheDocument();
        expect(screen.getByText("Hi there!")).toBeInTheDocument();
      });
    });

    it("displays split-pane with theme-aware layout (PRD left, Discuss right)", () => {
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
      });
      const { container } = renderSketchPhase(store);
      // Main split-pane wrapper uses theme bg
      const splitPane = container.querySelector("[class*='bg-theme-bg']");
      expect(splitPane).toBeInTheDocument();
      // Discuss sidebar is on the right (PrdChatPanel with variant inline)
      expect(screen.getByTestId("prd-chat-sidebar")).toBeInTheDocument();
      expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
    });

    it("collapses and expands Discuss sidebar when collapse/expand buttons are clicked", async () => {
      const user = userEvent.setup();
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
      });
      renderSketchPhase(store);

      // Initially expanded: full Discuss panel with collapse button
      expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
      const collapseBtn = screen.getByRole("button", { name: "Collapse Discuss sidebar" });
      expect(collapseBtn).toBeInTheDocument();

      // Click collapse
      await user.click(collapseBtn);
      // Collapsed: narrow bar with expand button (Discuss title hidden in collapsed bar)
      expect(screen.getByRole("button", { name: "Expand Discuss sidebar" })).toBeInTheDocument();

      // Click expand
      await user.click(screen.getByRole("button", { name: "Expand Discuss sidebar" }));
      expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Collapse Discuss sidebar" })).toBeInTheDocument();
    });

    it("shows resize handle when Discuss sidebar is expanded (drag to widen)", () => {
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
      });
      renderSketchPhase(store);
      expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
      expect(screen.getByRole("slider", { name: "Resize Discuss sidebar" })).toBeInTheDocument();
    });

    it("keeps Sketch sidebars above sticky content so resize handles stay full-height", () => {
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
      });
      renderSketchPhase(store);

      const tocHandle = screen.getByRole("slider", { name: "Resize table of contents" });
      const discussHandle = screen.getByRole("slider", { name: "Resize Discuss sidebar" });

      expect(tocHandle.closest(".relative")).toHaveClass("z-40");
      expect(discussHandle.closest(".relative")).toHaveClass("z-40");
      expect(tocHandle).toHaveClass("inset-y-0");
      expect(discussHandle).toHaveClass("inset-y-0");
    });

    it("persists Discuss sidebar width to localStorage when resized", () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
      });
      renderSketchPhase(store);
      const handle = screen.getByRole("slider", { name: "Resize Discuss sidebar" });
      handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(setItemSpy).toHaveBeenCalledWith(
        "opensprint-sidebar-width-sketch",
        expect.any(String)
      );
      setItemSpy.mockRestore();
    });

    it("Discuss sidebar scrolls to top on Sketch page load (matches Plan phase)", async () => {
      const store = createStore({
        sketch: {
          prdContent: { overview: "Content" },
          messages: [
            { role: "user", content: "Hello", timestamp: "" },
            { role: "assistant", content: "Hi there!", timestamp: "" },
          ],
        },
      });
      const { rerender } = renderSketchPhase(store);

      const scrollEl = screen.getByTestId("prd-chat-messages");
      Object.defineProperty(scrollEl, "scrollHeight", { value: 200, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 100, configurable: true });

      rerender();

      await new Promise((r) => requestAnimationFrame(r));

      expect(scrollEl.scrollTop).toBe(0);
    });

    describe("Discuss popover (selection toolbar)", () => {
      let getSelectionSpy: ReturnType<typeof vi.spyOn> | null = null;

      const collapsedSel = {
        isCollapsed: true,
        rangeCount: 0,
        toString: () => "",
        anchorNode: null,
        focusNode: null,
        getRangeAt: () => document.createRange(),
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      } as unknown as Selection;

      /** Simulate text selection in PRD and trigger mouseup to show the Discuss popover */
      function showDiscussPopover(sectionKey: string) {
        const contentEl = screen.getByTestId(`prd-content-${sectionKey}`);
        const sectionEl = contentEl.closest("[data-prd-section]") ?? contentEl.parentElement!;
        const text = contentEl.textContent || "selected text";
        const range = document.createRange();
        range.selectNodeContents(contentEl);

        const mockSel = {
          isCollapsed: false,
          rangeCount: 1,
          toString: () => text,
          anchorNode: contentEl.firstChild || contentEl,
          focusNode: contentEl.firstChild || contentEl,
          getRangeAt: () => range,
          removeAllRanges: vi.fn(),
          addRange: vi.fn(),
        };
        getSelectionSpy?.mockRestore();
        getSelectionSpy = vi
          .spyOn(window, "getSelection")
          .mockReturnValue(mockSel as unknown as Selection);

        fireEvent.mouseUp(sectionEl);
      }

      /** Reset getSelection mock to return collapsed/empty selection for dismiss tests */
      function clearSelectionMock() {
        getSelectionSpy?.mockRestore();
        getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue(collapsedSel);
      }

      afterEach(() => {
        getSelectionSpy?.mockRestore();
        getSelectionSpy = null;
      });

      it("shows Discuss popover when user selects text in PRD", async () => {
        const store = createStore({
          sketch: { prdContent: { executive_summary: "Some summary text to select" } },
        });
        renderSketchPhase(store);

        showDiscussPopover("executive_summary");

        await waitFor(() => {
          const popover = screen.getByTestId("discuss-popover");
          expect(popover).toBeInTheDocument();
          expect(within(popover).getByRole("button", { name: /Discuss/i })).toBeInTheDocument();
        });
      });

      it("clicking Discuss button moves selection to chat and focuses input", async () => {
        const user = userEvent.setup();
        const store = createStore({
          sketch: { prdContent: { executive_summary: "Selected text" } },
        });
        renderSketchPhase(store);

        showDiscussPopover("executive_summary");

        await waitFor(() => {
          expect(screen.getByTestId("discuss-popover")).toBeInTheDocument();
        });

        const popover = screen.getByTestId("discuss-popover");
        const discussBtn = within(popover).getByRole("button", { name: /Discuss/i });
        await user.click(discussBtn);

        await waitFor(() => {
          expect(screen.queryByTestId("discuss-popover")).not.toBeInTheDocument();
          expect(screen.getByText(/Discussing: Executive Summary/i)).toBeInTheDocument();
          expect(screen.getByPlaceholderText(/Comment on this selection/)).toBeInTheDocument();
        });

        await waitFor(
          () => {
            const input = screen.getByPlaceholderText(/Comment on this selection/);
            expect(document.activeElement).toBe(input);
          },
          { timeout: 200 }
        );
      });

      it("dismisses popover when clicking outside popover and selection", async () => {
        const user = userEvent.setup();
        const store = createStore({
          sketch: { prdContent: { executive_summary: "Some text" } },
        });
        renderSketchPhase(store);

        showDiscussPopover("executive_summary");

        await waitFor(() => {
          expect(screen.getByTestId("discuss-popover")).toBeInTheDocument();
        });

        clearSelectionMock();
        await user.click(screen.getByRole("heading", { name: /Product Requirements Document/i }));

        await waitFor(() => {
          expect(screen.queryByTestId("discuss-popover")).not.toBeInTheDocument();
        });
      });

      it("dismisses popover when clicking in chat input area", async () => {
        const user = userEvent.setup();
        const store = createStore({
          sketch: { prdContent: { executive_summary: "Some text" } },
        });
        renderSketchPhase(store);

        showDiscussPopover("executive_summary");

        await waitFor(() => {
          expect(screen.getByTestId("discuss-popover")).toBeInTheDocument();
        });

        clearSelectionMock();
        const chatInput = screen.getByPlaceholderText(/Ask about your PRD/);
        await user.click(chatInput);

        await waitFor(() => {
          expect(screen.queryByTestId("discuss-popover")).not.toBeInTheDocument();
        });
      });

      it("dismisses popover when clicking on different PRD section (outside highlighted text)", async () => {
        const user = userEvent.setup();
        const store = createStore({
          sketch: {
            prdContent: {
              executive_summary: "First section text",
              goals_and_metrics: "Second section text",
            },
          },
        });
        renderSketchPhase(store);

        showDiscussPopover("executive_summary");

        await waitFor(() => {
          expect(screen.getByTestId("discuss-popover")).toBeInTheDocument();
        });

        clearSelectionMock();
        const otherSectionContent = screen.getByTestId("prd-content-goals_and_metrics");
        await user.click(otherSectionContent);

        await waitFor(() => {
          expect(screen.queryByTestId("discuss-popover")).not.toBeInTheDocument();
        });
      });

      it("does not dismiss when clicking Discuss button (triggers discuss flow)", async () => {
        const user = userEvent.setup();
        const store = createStore({
          sketch: { prdContent: { executive_summary: "Some text" } },
        });
        renderSketchPhase(store);

        showDiscussPopover("executive_summary");

        await waitFor(() => {
          expect(screen.getByTestId("discuss-popover")).toBeInTheDocument();
        });

        const popover = screen.getByTestId("discuss-popover");
        const discussBtn = within(popover).getByRole("button", { name: /Discuss/i });
        await user.click(discussBtn);

        await waitFor(() => {
          expect(screen.queryByTestId("discuss-popover")).not.toBeInTheDocument();
          expect(screen.getByText(/Discussing: Executive Summary/i)).toBeInTheDocument();
        });
      });

      it("opens collapsed sidebar when Discuss is clicked with sidebar closed", async () => {
        const user = userEvent.setup();
        const STORAGE_KEY = "opensprint-sketch-chat-sidebar-collapsed";
        const localStorageMock: Record<string, string> = { [STORAGE_KEY]: "true" };
        vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
          return localStorageMock[key] ?? null;
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
          localStorageMock[key] = value;
        });

        const store = createStore({
          sketch: { prdContent: { executive_summary: "Selected text" } },
        });
        renderSketchPhase(store);

        expect(screen.getByRole("button", { name: "Expand Discuss sidebar" })).toBeInTheDocument();
        expect(screen.queryByText(/Discussing:/i)).not.toBeInTheDocument();

        showDiscussPopover("executive_summary");

        await waitFor(() => {
          expect(screen.getByTestId("discuss-popover")).toBeInTheDocument();
        });

        const popover = screen.getByTestId("discuss-popover");
        const discussBtn = within(popover).getByRole("button", { name: /Discuss/i });
        await user.click(discussBtn);

        await waitFor(() => {
          // Sidebar opens and shows Discussing context
          expect(
            screen.getByRole("button", { name: "Collapse Discuss sidebar" })
          ).toBeInTheDocument();
          expect(screen.getByText(/Discussing: Executive Summary/i)).toBeInTheDocument();
          expect(screen.getByPlaceholderText(/Comment on this selection/)).toBeInTheDocument();
        });

        // Input receives focus after sidebar expansion (250ms delay)
        await waitFor(
          () => {
            const input = screen.getByPlaceholderText(/Comment on this selection/);
            expect(document.activeElement).toBe(input);
          },
          { timeout: 500 }
        );

        vi.restoreAllMocks();
      });

      it("replaces popover when user selects new text elsewhere in PRD", async () => {
        const store = createStore({
          sketch: {
            prdContent: {
              executive_summary: "First section text",
              goals_and_metrics: "Second section text",
            },
          },
        });
        renderSketchPhase(store);

        showDiscussPopover("executive_summary");

        await waitFor(() => {
          expect(screen.getByTestId("discuss-popover")).toBeInTheDocument();
        });

        // Select text in different section - popover should move to new selection
        showDiscussPopover("goals_and_metrics");

        await waitFor(() => {
          const popover = screen.getByTestId("discuss-popover");
          expect(popover).toBeInTheDocument();
          expect(within(popover).getByRole("button", { name: /Discuss/i })).toBeInTheDocument();
        });
      });
    });

    describe("chat sidebar persistence across sessions", () => {
      const STORAGE_KEY = "opensprint-sketch-chat-sidebar-collapsed";
      let localStorageMock: Record<string, string>;

      beforeEach(() => {
        localStorageMock = {};
        vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
          return localStorageMock[key] ?? null;
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
          localStorageMock[key] = value;
        });
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("defaults to expanded when localStorage has no value", () => {
        // Do not set STORAGE_KEY in localStorageMock - simulates first visit
        const store = createStore({
          sketch: { prdContent: { overview: "Content" } },
        });
        renderSketchPhase(store);

        expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Collapse Discuss sidebar" })
        ).toBeInTheDocument();
      });

      it("restores collapsed state from localStorage when true", () => {
        localStorageMock[STORAGE_KEY] = "true";

        const store = createStore({
          sketch: { prdContent: { overview: "Content" } },
        });
        renderSketchPhase(store);

        // Sidebar should start collapsed (narrow bar with expand button)
        expect(screen.getByRole("button", { name: "Expand Discuss sidebar" })).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Collapse Discuss sidebar" })
        ).not.toBeInTheDocument();
      });

      it("restores expanded state from localStorage when false", () => {
        localStorageMock[STORAGE_KEY] = "false";

        const store = createStore({
          sketch: { prdContent: { overview: "Content" } },
        });
        renderSketchPhase(store);

        expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Collapse Discuss sidebar" })
        ).toBeInTheDocument();
      });

      it("persists collapsed state to localStorage when user collapses sidebar", async () => {
        const user = userEvent.setup();
        const store = createStore({
          sketch: { prdContent: { overview: "Content" } },
        });
        renderSketchPhase(store);

        await user.click(screen.getByRole("button", { name: "Collapse Discuss sidebar" }));

        expect(localStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, "true");
      });

      it("persists expanded state to localStorage when user expands sidebar", async () => {
        const user = userEvent.setup();
        localStorageMock[STORAGE_KEY] = "true";

        const store = createStore({
          sketch: { prdContent: { overview: "Content" } },
        });
        renderSketchPhase(store);

        await user.click(screen.getByRole("button", { name: "Expand Discuss sidebar" }));

        expect(localStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, "false");
      });
    });

    it("shows Plan it when planStatus.action is plan", async () => {
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
        plan: {
          planStatus: { hasPlanningRun: false, prdChangedSinceLastRun: false, action: "plan" },
        },
      });
      renderSketchPhase(store);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Plan it/i })).toBeInTheDocument();
      });
      expect(screen.getByTestId("sketch-plan-cta")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Replan it/i })).not.toBeInTheDocument();
    });

    it("shows Replan it when planStatus.action is replan", async () => {
      mockGetPlanStatus.mockResolvedValue({
        hasPlanningRun: true,
        prdChangedSinceLastRun: true,
        action: "replan",
      });
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
        plan: {
          planStatus: { hasPlanningRun: true, prdChangedSinceLastRun: true, action: "replan" },
        },
      });
      renderSketchPhase(store);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Replan it/i })).toBeInTheDocument();
      });
      expect(screen.getByTestId("sketch-plan-cta")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Plan it$/i })).not.toBeInTheDocument();
    });

    it("hides CTA button when planStatus.action is none", async () => {
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
        plan: {
          planStatus: { hasPlanningRun: true, prdChangedSinceLastRun: false, action: "none" },
        },
      });
      renderSketchPhase(store);
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /Plan it/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Replan it/i })).not.toBeInTheDocument();
      });
    });

    it("hides CTA button when planStatus is null (loading)", () => {
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
        plan: { planStatus: null },
      });
      renderSketchPhase(store);
      expect(screen.queryByRole("button", { name: /Plan it/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Replan it/i })).not.toBeInTheDocument();
    });

    it("fetches plan-status on Sketch load when PRD exists", async () => {
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
      });
      renderSketchPhase(store);
      await waitFor(() => {
        expect(mockGetPlanStatus).toHaveBeenCalledWith("proj-1");
      });
    });

    it("disables CTA button during decomposing", async () => {
      let resolveDecompose: () => void;
      mockPlansDecompose.mockImplementation(
        () =>
          new Promise<void>((r) => {
            resolveDecompose = r;
          })
      );
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
        plan: {
          planStatus: { hasPlanningRun: false, prdChangedSinceLastRun: false, action: "plan" },
        },
      });
      renderSketchPhase(store);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Plan it/i })).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTestId("sketch-plan-cta"));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Planning/i })).toBeInTheDocument();
        expect(screen.getByTestId("sketch-plan-cta")).toBeDisabled();
      });
      resolveDecompose!();
      mockPlansDecompose.mockResolvedValue({ created: 2, plans: [] });
    });

    it("dispatches fetchPlanStatus after savePrdSection succeeds", async () => {
      const user = userEvent.setup();
      const store = createStore({
        sketch: {
          prdContent: {
            executive_summary: "Original",
            goals_and_metrics: "Goals",
          },
        },
      });
      mockPrdUpdateSection.mockResolvedValue(undefined);
      renderSketchPhase(store);

      const inputA = screen.getByTestId("prd-input-executive_summary");
      await user.clear(inputA);
      await user.type(inputA, "Updated summary");

      await waitFor(() => {
        expect(mockPrdUpdateSection).toHaveBeenCalledWith(
          "proj-1",
          "executive_summary",
          "Updated summary"
        );
      });

      await waitFor(() => {
        expect(mockGetPlanStatus).toHaveBeenCalledWith("proj-1");
      });
    });

    describe("mobile layout", () => {
      beforeEach(() => {
        mockViewportWidth = 400;
      });
      afterEach(() => {
        mockViewportWidth = 1024;
      });

      it("shows TOC and Chat FABs when sidebars collapsed on mobile", () => {
        const STORAGE_KEY_CHAT = "opensprint-sketch-chat-sidebar-collapsed";
        const STORAGE_KEY_TOC = "opensprint-sketch-toc-sidebar-collapsed";
        const localStorageMock: Record<string, string> = {
          [STORAGE_KEY_CHAT]: "true",
          [STORAGE_KEY_TOC]: "true",
        };
        vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
          return localStorageMock[key] ?? null;
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
          localStorageMock[key] = value;
        });

        const store = createStore({
          sketch: { prdContent: { overview: "Content" } },
        });
        renderSketchPhase(store);

        expect(screen.getByTestId("sketch-toc-fab")).toBeInTheDocument();
        expect(screen.getByTestId("sketch-chat-fab")).toBeInTheDocument();
        expect(screen.getByLabelText("Open table of contents")).toBeInTheDocument();
        expect(screen.getByLabelText("Open Discuss")).toBeInTheDocument();
        vi.restoreAllMocks();
      });

      it("opens TOC overlay when TOC FAB is clicked on mobile", async () => {
        const user = userEvent.setup();
        const STORAGE_KEY_TOC = "opensprint-sketch-toc-sidebar-collapsed";
        const localStorageMock: Record<string, string> = { [STORAGE_KEY_TOC]: "true" };
        vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
          return localStorageMock[key] ?? null;
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
          localStorageMock[key] = value;
        });

        const store = createStore({
          sketch: {
            prdContent: {
              executive_summary: "Summary",
              goals_and_metrics: "Goals",
            },
          },
        });
        renderSketchPhase(store);

        await user.click(screen.getByTestId("sketch-toc-fab"));

        await waitFor(() => {
          expect(screen.getByTestId("prd-toc-sidebar")).toBeInTheDocument();
          expect(screen.getByText("Contents")).toBeInTheDocument();
        });
        vi.restoreAllMocks();
      });

      it("opens Chat overlay when Chat FAB is clicked on mobile", async () => {
        const user = userEvent.setup();
        const STORAGE_KEY_CHAT = "opensprint-sketch-chat-sidebar-collapsed";
        const localStorageMock: Record<string, string> = { [STORAGE_KEY_CHAT]: "true" };
        vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
          return localStorageMock[key] ?? null;
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
          localStorageMock[key] = value;
        });

        const store = createStore({
          sketch: { prdContent: { overview: "Content" } },
        });
        renderSketchPhase(store);

        await user.click(screen.getByTestId("sketch-chat-fab"));

        await waitFor(() => {
          expect(screen.getByTestId("prd-chat-sidebar")).toBeInTheDocument();
          expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
        });
        vi.restoreAllMocks();
      });

      it("hides collapsed sidebars on mobile so PRD is full width", () => {
        const STORAGE_KEY_CHAT = "opensprint-sketch-chat-sidebar-collapsed";
        const STORAGE_KEY_TOC = "opensprint-sketch-toc-sidebar-collapsed";
        const localStorageMock: Record<string, string> = {
          [STORAGE_KEY_CHAT]: "true",
          [STORAGE_KEY_TOC]: "true",
        };
        vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
          return localStorageMock[key] ?? null;
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
          localStorageMock[key] = value;
        });

        const store = createStore({
          sketch: { prdContent: { overview: "Content" } },
        });
        const { container } = renderSketchPhase(store);

        expect(screen.getByTestId("sketch-toc-fab")).toBeInTheDocument();
        expect(screen.getByTestId("sketch-chat-fab")).toBeInTheDocument();
        expect(screen.queryByTestId("prd-toc-sidebar")).not.toBeInTheDocument();
        expect(screen.queryByTestId("prd-chat-sidebar")).not.toBeInTheDocument();
        expect(screen.getByText("Product Requirements Document")).toBeInTheDocument();
        const prdContent = container.querySelector("[class*='max-w-4xl']");
        expect(prdContent).toBeInTheDocument();
        vi.restoreAllMocks();
      });
    });

    it("saves multiple sections independently (multi-section edits)", async () => {
      const user = userEvent.setup();
      const store = createStore({
        sketch: {
          prdContent: {
            executive_summary: "Summary",
            goals_and_metrics: "Goals",
            feature_list: "Features",
          },
        },
      });
      mockPrdUpdateSection.mockResolvedValue(undefined);
      renderSketchPhase(store);

      const input1 = screen.getByTestId("prd-input-executive_summary");
      const input2 = screen.getByTestId("prd-input-goals_and_metrics");
      await user.clear(input1);
      await user.type(input1, "New summary");
      await user.clear(input2);
      await user.type(input2, "New goals");

      await waitFor(() => {
        expect(mockPrdUpdateSection).toHaveBeenCalledWith(
          "proj-1",
          "executive_summary",
          "New summary"
        );
      });
      await waitFor(() => {
        expect(mockPrdUpdateSection).toHaveBeenCalledWith(
          "proj-1",
          "goals_and_metrics",
          "New goals"
        );
      });
    });
  });
});
