// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { SketchPhase } from "./SketchPhase";
import sketchReducer from "../../store/slices/sketchSlice";
import planReducer, { decomposePlans } from "../../store/slices/planSlice";

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
const mockPlansDecompose = vi.fn();

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
      updateSection: (...args: unknown[]) => mockPrdUpdateSection(...args),
      upload: (...args: unknown[]) => mockPrdUpload(...args),
    },
    plans: {
      decompose: (...args: unknown[]) => mockPlansDecompose(...args),
    },
    projects: {
      getPlanStatus: (...args: unknown[]) => mockGetPlanStatus(...args),
      getSketchContext: vi.fn().mockResolvedValue({ hasExistingCode: false }),
    },
  },
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
  return render(
    <Provider store={store}>
      <SketchPhase projectId="proj-1" />
    </Provider>
  );
}

describe("SketchPhase with sketchSlice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatSend.mockResolvedValue({ message: "Response" });
    mockChatHistory.mockResolvedValue({ messages: [] });
    mockPrdGet.mockResolvedValue({ sections: {} });
    mockPrdGetHistory.mockResolvedValue([]);
    mockPrdUpdateSection.mockResolvedValue(undefined);
    mockPlansDecompose.mockResolvedValue({ created: 2, plans: [] });
    mockGetPlanStatus.mockResolvedValue({
      hasPlanningRun: false,
      prdChangedSinceLastRun: false,
      action: "plan",
    });
  });

  describe("initial prompt view (no PRD) — empty-state onboarding", () => {
    it("renders central prompt when prdContent is empty", () => {
      renderSketchPhase();
      expect(screen.getByText("What do you want to build?")).toBeInTheDocument();
      expect(screen.getByText(/Describe your app idea and AI will generate/)).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("renders file upload button in empty state", () => {
      renderSketchPhase();
      expect(screen.getByText("Upload existing PRD")).toBeInTheDocument();
      expect(screen.getByText(/.md, .docx, .pdf/)).toBeInTheDocument();
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
        expect(screen.getByText(/This may take a moment/)).toBeInTheDocument();
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
      expect(screen.getByRole("heading", { name: "Goals And Metrics" })).toBeInTheDocument();
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
      });
      expect(screen.getByText("Hello")).toBeInTheDocument();
      expect(screen.getByText("Hi there!")).toBeInTheDocument();
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
      expect(screen.getByRole("separator", { name: "Resize Discuss sidebar" })).toBeInTheDocument();
    });

    it("persists Discuss sidebar width to localStorage when resized", () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
      const store = createStore({
        sketch: { prdContent: { overview: "Content" } },
      });
      renderSketchPhase(store);
      const handle = screen.getByRole("separator", { name: "Resize Discuss sidebar" });
      handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(setItemSpy).toHaveBeenCalledWith(
        "opensprint-sidebar-width-sketch",
        expect.any(String)
      );
      setItemSpy.mockRestore();
    });

    it("Discuss sidebar scrolls to bottom on Sketch page load", async () => {
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

      rerender(
        <Provider store={store}>
          <SketchPhase projectId="proj-1" />
        </Provider>
      );

      await new Promise((r) => requestAnimationFrame(r));

      expect(scrollEl.scrollTop).toBe(100);
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

      store.dispatch(decomposePlans("proj-1"));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Planning/i })).toBeDisabled();
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
