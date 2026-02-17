import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { DreamPhase } from "./DreamPhase";
import designReducer from "../../store/slices/designSlice";
import planReducer, { decomposePlans } from "../../store/slices/planSlice";

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
    },
  },
}));

function createStore(preloadedState?: {
  design?: {
    messages?: { role: "user" | "assistant"; content: string; timestamp: string }[];
    prdContent?: Record<string, string>;
    prdHistory?: unknown[];
  };
  plan?: { planStatus?: { action: "plan" | "replan" | "none" } };
}) {
  return configureStore({
    reducer: {
      design: designReducer,
      plan: planReducer,
    },
    preloadedState: {
      design: {
        messages: preloadedState?.design?.messages ?? [],
        prdContent: preloadedState?.design?.prdContent ?? {},
        prdHistory: preloadedState?.design?.prdHistory ?? [],
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
        shippingPlanId: null,
        reshippingPlanId: null,
        archivingPlanId: null,
        error: null,
      },
    },
  });
}

function renderDreamPhase(store = createStore()) {
  return render(
    <Provider store={store}>
      <DreamPhase projectId="proj-1" />
    </Provider>,
  );
}

describe("DreamPhase with designSlice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatSend.mockResolvedValue({ message: "Response" });
    mockChatHistory.mockResolvedValue({ messages: [] });
    mockPrdGet.mockResolvedValue({ sections: {} });
    mockPrdGetHistory.mockResolvedValue([]);
    mockPrdUpdateSection.mockResolvedValue(undefined);
    mockPlansDecompose.mockResolvedValue({ created: 2, plans: [] });
    mockGetPlanStatus.mockResolvedValue({ hasPlanningRun: false, prdChangedSinceLastRun: false, action: "plan" });
  });

  describe("initial prompt view (no PRD)", () => {
    it("renders initial prompt when prdContent is empty", () => {
      renderDreamPhase();
      expect(screen.getByText("What do you want to build?")).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("dispatches sendDesignMessage when user submits initial idea", async () => {
      const user = userEvent.setup();
      const store = createStore();
      renderDreamPhase(store);

      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "A todo app");
      await user.click(screen.getByTitle("Dream it"));

      await waitFor(() => {
        expect(mockChatSend).toHaveBeenCalledWith("proj-1", "A todo app", "dream", undefined);
      });
    });
  });

  describe("PRD document view", () => {
    it("renders PRD sections when prdContent exists", () => {
      const store = createStore({
        design: {
          prdContent: {
            executive_summary: "Summary text",
            goals_and_metrics: "Goals text",
          },
        },
      });
      renderDreamPhase(store);

      expect(screen.getByText("Product Requirements Document")).toBeInTheDocument();
      expect(screen.getByText("Executive Summary")).toBeInTheDocument();
      expect(screen.getByText("Goals And Metrics")).toBeInTheDocument();
      expect(screen.getByTestId("prd-content-executive_summary")).toHaveTextContent("Summary text");
      expect(screen.getByTestId("prd-content-goals_and_metrics")).toHaveTextContent("Goals text");
    });

    it("dispatches savePrdSection when user edits section (debounced autosave)", async () => {
      const user = userEvent.setup();
      const store = createStore({
        design: { prdContent: { overview: "Original content" } },
      });
      renderDreamPhase(store);

      const input = screen.getByTestId("prd-input-overview");
      await user.clear(input);
      await user.type(input, "Updated content");

      await waitFor(() => {
        expect(mockPrdUpdateSection).toHaveBeenLastCalledWith(
          "proj-1",
          "overview",
          "Updated content",
        );
      });
    });

    it("displays chat and messages in split-pane when PRD exists", () => {
      const store = createStore({
        design: {
          prdContent: { overview: "Content" },
          messages: [
            { role: "user", content: "Hello", timestamp: "2025-01-01" },
            { role: "assistant", content: "Hi there!", timestamp: "2025-01-01" },
          ],
        },
      });
      renderDreamPhase(store);

      // Chat is always visible in split-pane (left pane)
      expect(screen.getByTestId("prd-chat-sidebar")).toBeInTheDocument();
      expect(screen.getByText("Hello")).toBeInTheDocument();
      expect(screen.getByText("Hi there!")).toBeInTheDocument();
    });

    it("shows Plan it when planStatus.action is plan", async () => {
      const store = createStore({
        design: { prdContent: { overview: "Content" } },
        plan: { planStatus: { hasPlanningRun: false, prdChangedSinceLastRun: false, action: "plan" } },
      });
      renderDreamPhase(store);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Plan it/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole("button", { name: /Replan it/i })).not.toBeInTheDocument();
    });

    it("shows Replan it when planStatus.action is replan", async () => {
      const store = createStore({
        design: { prdContent: { overview: "Content" } },
        plan: { planStatus: { hasPlanningRun: true, prdChangedSinceLastRun: true, action: "replan" } },
      });
      renderDreamPhase(store);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Replan it/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole("button", { name: /Plan it/i })).not.toBeInTheDocument();
    });

    it("hides CTA button when planStatus.action is none", async () => {
      const store = createStore({
        design: { prdContent: { overview: "Content" } },
        plan: { planStatus: { hasPlanningRun: true, prdChangedSinceLastRun: false, action: "none" } },
      });
      renderDreamPhase(store);
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /Plan it/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Replan it/i })).not.toBeInTheDocument();
      });
    });

    it("hides CTA button when planStatus is null (loading)", () => {
      const store = createStore({
        design: { prdContent: { overview: "Content" } },
        plan: { planStatus: null },
      });
      renderDreamPhase(store);
      expect(screen.queryByRole("button", { name: /Plan it/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Replan it/i })).not.toBeInTheDocument();
    });

    it("fetches plan-status on Dream load when PRD exists", async () => {
      const store = createStore({
        design: { prdContent: { overview: "Content" } },
      });
      renderDreamPhase(store);
      await waitFor(() => {
        expect(mockGetPlanStatus).toHaveBeenCalledWith("proj-1");
      });
    });

    it("disables CTA button during decomposing", async () => {
      let resolveDecompose: () => void;
      mockPlansDecompose.mockImplementation(
        () => new Promise<void>((r) => { resolveDecompose = r; }),
      );
      const store = createStore({
        design: { prdContent: { overview: "Content" } },
        plan: { planStatus: { hasPlanningRun: false, prdChangedSinceLastRun: false, action: "plan" } },
      });
      renderDreamPhase(store);
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
        design: {
          prdContent: {
            executive_summary: "Original",
            goals_and_metrics: "Goals",
          },
        },
      });
      mockPrdUpdateSection.mockResolvedValue(undefined);
      renderDreamPhase(store);

      const inputA = screen.getByTestId("prd-input-executive_summary");
      await user.clear(inputA);
      await user.type(inputA, "Updated summary");

      await waitFor(() => {
        expect(mockPrdUpdateSection).toHaveBeenCalledWith(
          "proj-1",
          "executive_summary",
          "Updated summary",
        );
      });

      await waitFor(() => {
        expect(mockGetPlanStatus).toHaveBeenCalledWith("proj-1");
      });
    });

    it("saves multiple sections independently (multi-section edits)", async () => {
      const user = userEvent.setup();
      const store = createStore({
        design: {
          prdContent: {
            executive_summary: "Summary",
            goals_and_metrics: "Goals",
            feature_list: "Features",
          },
        },
      });
      mockPrdUpdateSection.mockResolvedValue(undefined);
      renderDreamPhase(store);

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
          "New summary",
        );
      });
      await waitFor(() => {
        expect(mockPrdUpdateSection).toHaveBeenCalledWith(
          "proj-1",
          "goals_and_metrics",
          "New goals",
        );
      });
    });
  });
});
