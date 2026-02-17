import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { DreamPhase } from "./DreamPhase";
import designReducer from "../../store/slices/designSlice";
import planReducer from "../../store/slices/planSlice";

const mockChatSend = vi.fn();
const mockChatHistory = vi.fn();
const mockPrdGet = vi.fn();
const mockPrdGetHistory = vi.fn();
const mockPrdUpdateSection = vi.fn();
const mockPrdUpload = vi.fn();
const mockPlansDecompose = vi.fn();

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
  },
}));

function createStore(preloadedDesign?: {
  messages?: { role: "user" | "assistant"; content: string; timestamp: string }[];
  prdContent?: Record<string, string>;
  prdHistory?: unknown[];
}) {
  return configureStore({
    reducer: {
      design: designReducer,
      plan: planReducer,
    },
    preloadedState: {
      design: {
        messages: preloadedDesign?.messages ?? [],
        prdContent: preloadedDesign?.prdContent ?? {},
        prdHistory: preloadedDesign?.prdHistory ?? [],
        sendingChat: false,
        savingSection: null,
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
        prdContent: {
          executive_summary: "Summary text",
          goals_and_metrics: "Goals text",
        },
      });
      renderDreamPhase(store);

      expect(screen.getByText("Product Requirements Document")).toBeInTheDocument();
      expect(screen.getByText("Executive Summary")).toBeInTheDocument();
      expect(screen.getByText("Goals And Metrics")).toBeInTheDocument();
    });

    it("dispatches savePrdSection when user saves edited section", async () => {
      const user = userEvent.setup();
      const store = createStore({
        prdContent: { overview: "Original content" },
      });
      renderDreamPhase(store);

      await user.click(screen.getByRole("button", { name: "Edit", hidden: true }));
      const textarea = screen.getByPlaceholder(/Markdown content/);
      await user.clear(textarea);
      await user.type(textarea, "Updated content");
      await user.click(screen.getByRole("button", { name: /^Save$/ }));

      await waitFor(() => {
        expect(mockPrdUpdateSection).toHaveBeenCalledWith("proj-1", "overview", "Updated content");
      });
    });

    it("uses design slice state for messages when chat is open", async () => {
      const user = userEvent.setup();
      const store = createStore({
        prdContent: { overview: "Content" },
        messages: [
          { role: "user", content: "Hello", timestamp: "2025-01-01" },
          { role: "assistant", content: "Hi there!", timestamp: "2025-01-01" },
        ],
      });
      renderDreamPhase(store);

      await user.click(screen.getByTitle("Chat with AI"));
      expect(screen.getByText("Hello")).toBeInTheDocument();
      expect(screen.getByText("Hi there!")).toBeInTheDocument();
    });
  });
});
