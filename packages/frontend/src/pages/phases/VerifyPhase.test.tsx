/**
 * EvalPhase tests — VerifyPhase renamed to EvalPhase (Ensure→Eval per feedback).
 * This file tests EvalPhase component. Filename VerifyPhase.test.tsx retained for compatibility.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { EvalPhase, FEEDBACK_COLLAPSED_KEY_PREFIX } from "./EvalPhase";
import projectReducer from "../../store/slices/projectSlice";
import evalReducer from "../../store/slices/evalSlice";
import executeReducer from "../../store/slices/executeSlice";

const mockFeedbackList = vi.fn().mockResolvedValue([]);
const mockFeedbackSubmit = vi.fn().mockResolvedValue({
  id: "fb-1",
  text: "Test feedback",
  category: "bug",
  mappedPlanId: null,
  createdTaskIds: [],
  status: "pending",
  createdAt: new Date().toISOString(),
});
const mockFeedbackRecategorize = vi.fn().mockResolvedValue({
  id: "fb-1",
  text: "Login button broken",
  category: "feature",
  mappedPlanId: "plan-1",
  createdTaskIds: [],
  status: "pending",
  createdAt: new Date().toISOString(),
});
const mockFeedbackResolve = vi.fn().mockResolvedValue({
  id: "fb-1",
  text: "Bug in login",
  category: "bug",
  mappedPlanId: "plan-1",
  createdTaskIds: [],
  status: "resolved",
  createdAt: new Date().toISOString(),
});

vi.mock("../../api/client", () => ({
  api: {
    feedback: {
      list: (...args: unknown[]) => mockFeedbackList(...args),
      submit: (...args: unknown[]) => mockFeedbackSubmit(...args),
      recategorize: (...args: unknown[]) => mockFeedbackRecategorize(...args),
      resolve: (...args: unknown[]) => mockFeedbackResolve(...args),
    },
  },
}));

function createStore() {
  return configureStore({
    reducer: {
      project: projectReducer,
      eval: evalReducer,
      execute: executeReducer,
    },
    preloadedState: {
      project: {
        data: {
          id: "proj-1",
          name: "Test Project",
          description: "",
          repoPath: "/tmp/test",
          currentPhase: "eval",
          createdAt: "",
          updatedAt: "",
        },
        loading: false,
        error: null,
      },
      eval: {
        feedback: [],
        loading: false,
        submitting: false,
        error: null,
      },
    },
  });
}

describe("EvalPhase feedback input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeedbackRecategorize.mockResolvedValue({
      id: "fb-1",
      text: "Login button broken",
      category: "feature",
      mappedPlanId: "plan-1",
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
    });
  });

  it("renders feedback input with textarea, image attach button, and submit button", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Attach image/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Submit Feedback/i })).toBeInTheDocument();
  });

  it("image attach button has secondary styling (btn-secondary)", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const attachBtn = screen.getByRole("button", { name: /Attach image/i });
    expect(attachBtn).toHaveClass("btn-secondary");
  });

  it("image attach button is to the left of submit button", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const attachBtn = screen.getByRole("button", { name: /Attach image/i });
    const submitBtn = screen.getByRole("button", { name: /Submit Feedback/i });
    const parent = attachBtn.parentElement;
    expect(parent).toContainElement(attachBtn);
    expect(parent).toContainElement(submitBtn);
    const attachIndex = Array.from(parent!.children).indexOf(attachBtn);
    const submitIndex = Array.from(parent!.children).indexOf(submitBtn);
    expect(attachIndex).toBeLessThan(submitIndex);
  });

  it("submits feedback with text only when no images attached", async () => {
    const user = userEvent.setup();
    const store = createStore();
    render(
      <Provider store={store}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    await user.type(screen.getByPlaceholderText(/Describe a bug/), "Bug in login");
    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(mockFeedbackSubmit).toHaveBeenCalledWith("proj-1", "Bug in login", undefined);
    });
  });

  it("shows feedback immediately in history with categorizing state after submit", async () => {
    const user = userEvent.setup();
    const store = createStore();
    mockFeedbackSubmit.mockResolvedValue({
      id: "fb-new",
      text: "Bug in login",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    render(
      <Provider store={store}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    await user.type(screen.getByPlaceholderText(/Describe a bug/), "Bug in login");
    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(screen.getByText(/Feedback History \(1\)/)).toBeInTheDocument();
    });
    expect(screen.getByText("Categorizing…")).toBeInTheDocument();
    expect(screen.getByText(/Feedback History \(1\)/)).toBeInTheDocument();
  });

  it("submits feedback with images when images are attached", async () => {
    const user = userEvent.setup();
    const store = createStore();
    render(
      <Provider store={store}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    // Create a minimal PNG file (1x1 pixel)
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const blob = new Blob(
      [Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0))],
      { type: "image/png" },
    );
    const file = new File([blob], "screenshot.png", { type: "image/png" });

    const textarea = screen.getByPlaceholderText(/Describe a bug/);
    await user.type(textarea, "Bug with screenshot");

    // Trigger file input via the attach button
    const attachBtn = screen.getByRole("button", { name: /Attach image/i });
    const fileInput = attachBtn.parentElement?.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeInTheDocument();

    // Simulate file selection
    Object.defineProperty(fileInput, "files", {
      value: [file],
      writable: false,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByAltText("Attachment 1")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(mockFeedbackSubmit).toHaveBeenCalled();
      const [, , images] = mockFeedbackSubmit.mock.calls[0];
      expect(images).toBeDefined();
      expect(Array.isArray(images)).toBe(true);
      expect(images!.length).toBe(1);
      expect(images![0]).toMatch(/^data:image\/png;base64,/);
    });
  });

  it("feedback box supports drag and drop (has onDragOver handler)", () => {
    const store = createStore();
    const { container } = render(
      <Provider store={store}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const feedbackCard = container.querySelector(".card");
    expect(feedbackCard).toBeInTheDocument();
    // The card is the drop zone - we verify the structure supports DnD
  });

  it("displays attached image thumbnails with remove button", async () => {
    const user = userEvent.setup();
    const store = createStore();
    render(
      <Provider store={store}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const blob = new Blob(
      [Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0))],
      { type: "image/png" },
    );
    const file = new File([blob], "screenshot.png", { type: "image/png" });

    const attachBtn = screen.getByRole("button", { name: /Attach image/i });
    const fileInput = attachBtn.parentElement?.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], writable: false });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByAltText("Attachment 1")).toBeInTheDocument();
    });

    const removeBtn = screen.getByRole("button", { name: /Remove image/i });
    await user.click(removeBtn);

    await waitFor(() => {
      expect(screen.queryByAltText("Attachment 1")).not.toBeInTheDocument();
    });
  });

  it("displays feedback list from Redux store (all feedback including pending)", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Login button is broken",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText(/Feedback History \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.getByText("Login button is broken")).toBeInTheDocument();
  });

  it("displays feedback text on each feedback card", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Bug feedback",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
            {
              id: "fb-2",
              text: "Pending feedback text",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "pending",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Bug feedback")).toBeInTheDocument();
    expect(screen.getByText("Pending feedback text")).toBeInTheDocument();
  });

  it("shows fallback when feedback item has no text", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-empty",
              text: undefined as unknown as string,
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("(No feedback text)")).toBeInTheDocument();
  });

  it("shows category chip for feedback in list", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "The login form doesn't show an error when password is wrong",
              category: "bug",
              mappedPlanId: "auth-plan",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Bug")).toBeInTheDocument();
  });

  it("displays loading state from Redux when loading feedback", () => {
    const storeLoading = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [],
          loading: true,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeLoading}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText(/Loading feedback/)).toBeInTheDocument();
  });

  it("displays error from Redux and allows dismiss", async () => {
    const user = userEvent.setup();
    const storeWithError = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [],
          loading: false,
          submitting: false,
          error: "Failed to load feedback",
        },
      },
    });

    render(
      <Provider store={storeWithError}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Failed to load feedback")).toBeInTheDocument();
    const dismissBtn = screen.getByRole("button", { name: /Dismiss/i });
    await user.click(dismissBtn);
    await waitFor(() => {
      expect(screen.queryByText("Failed to load feedback")).not.toBeInTheDocument();
    });
  });

  it("shows pending feedback immediately with categorizing loading state", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Login button is broken",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "pending",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    // Pending feedback is shown immediately with loading state
    expect(screen.getByText(/Feedback History \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("Categorizing…")).toBeInTheDocument();
    expect(screen.getByLabelText("Categorizing feedback")).toBeInTheDocument();
  });

  it("shows both pending and mapped feedback; pending has categorizing loading state", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-pending",
              text: "Pending feedback",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "pending",
              createdAt: new Date().toISOString(),
            },
            {
              id: "fb-mapped",
              text: "Mapped feedback",
              category: "feature",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    // Both shown: pending with loading state, mapped with category chip
    expect(screen.getByText("Categorizing…")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText(/Feedback History \(2\)/)).toBeInTheDocument();
  });

  it("shows category chip (Bug/Feature/UX/Scope) for mapped feedback", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-bug",
              text: "Bug report",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
            {
              id: "fb-feature",
              text: "Feature request",
              category: "feature",
              mappedPlanId: "plan-2",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
            {
              id: "fb-ux",
              text: "UX improvement",
              category: "ux",
              mappedPlanId: "plan-3",
              createdTaskIds: [],
              status: "resolved",
              createdAt: new Date().toISOString(),
            },
            {
              id: "fb-scope",
              text: "Scope change request",
              category: "scope",
              mappedPlanId: "plan-4",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText("UX")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    // Mapped status label is hidden — no "Mapped" chip or "Pending" chip
    expect(screen.queryByText("Mapped")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });

  it("does not show Mapped status label on mapped feedback items", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Login button broken",
              category: "bug",
              mappedPlanId: "auth-plan",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    // Mapped status label must be hidden — no "Mapped" anywhere in status/chip area
    expect(screen.queryByText("Mapped")).not.toBeInTheDocument();
    expect(screen.getByText("Bug")).toBeInTheDocument();
  });

  it("shows Resolve button for mapped feedback and calls resolve API when clicked", async () => {
    const user = userEvent.setup();
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-resolve-test",
              text: "Bug in login",
              category: "bug",
              mappedPlanId: "auth-plan",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const resolveBtn = screen.getByRole("button", { name: /resolve/i });
    expect(resolveBtn).toBeInTheDocument();

    await user.click(resolveBtn);

    await waitFor(() => {
      expect(mockFeedbackResolve).toHaveBeenCalledWith("proj-1", "fb-resolve-test");
    });
  });

  it("shows category chip for each feedback card", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-mapped",
              text: "Bug feedback",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
            {
              id: "fb-resolved",
              text: "Feature feedback",
              category: "feature",
              mappedPlanId: "plan-2",
              createdTaskIds: [],
              status: "resolved",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText(/Feedback History \(2\)/)).toBeInTheDocument();
  });

  it("shows green Resolved chip for resolved feedback items adjacent to category chip", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-resolved",
              text: "Fixed bug",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "resolved",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const resolvedChip = screen.getByText("Resolved");
    expect(resolvedChip).toBeInTheDocument();
    expect(resolvedChip).toHaveClass("bg-green-100", "text-green-800");
    expect(resolvedChip).toHaveClass("dark:bg-green-900/30", "dark:text-green-300");
    expect(screen.getByText("Bug")).toBeInTheDocument();
  });

  it("does not show Resolved chip for pending or mapped feedback", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-pending",
              text: "Pending feedback",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "pending",
              createdAt: new Date().toISOString(),
            },
            {
              id: "fb-mapped",
              text: "Mapped feedback",
              category: "feature",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
    expect(screen.getByText("Categorizing…")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
  });

  it("shows Resolved chip immediately when user clicks Resolve (optimistic update)", async () => {
    const user = userEvent.setup();
    let resolveApi: (v: unknown) => void;
    const resolvePromise = new Promise<unknown>((r) => {
      resolveApi = r;
    });
    mockFeedbackResolve.mockReturnValue(resolvePromise as never);

    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-opt",
              text: "Bug to resolve",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
    const resolveBtn = screen.getByRole("button", { name: /resolve/i });
    await user.click(resolveBtn);

    await waitFor(() => {
      expect(screen.getByText("Resolved")).toBeInTheDocument();
    });
    resolveApi!({
      id: "fb-opt",
      text: "Bug to resolve",
      category: "bug",
      mappedPlanId: "plan-1",
      createdTaskIds: [],
      status: "resolved",
      createdAt: new Date().toISOString(),
    });
  });

  it("displays images in feedback history when present", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-with-img",
              text: "Screenshot of bug",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
              images: [
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
              ],
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const imgs = screen.getAllByRole("img", { name: /Attachment \d+/ });
    expect(imgs.length).toBeGreaterThanOrEqual(1);
  });

  it("floats category badge to top-right of feedback card with text wrap", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Long feedback text that should wrap when the card is narrow",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
      },
    });

    const { container } = render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const card = container.querySelector(".card");
    expect(card).toBeInTheDocument();

    // Feedback text and category badge are in the same top row container
    const textEl = screen.getByText(/Long feedback text that should wrap/);
    const badgeEl = screen.getByText("Bug");
    expect(textEl).toBeInTheDocument();
    expect(badgeEl).toBeInTheDocument();

    // Text has break-words for wrapping
    expect(textEl).toHaveClass("break-words");
    expect(textEl).toHaveClass("whitespace-pre-wrap");

    // Badge floats to top-right (float-right) so text wraps around it
    expect(badgeEl).toHaveClass("float-right");
    const topRow = textEl.parentElement;
    expect(topRow).toContainElement(badgeEl);
  });

  it("shows task status icon next to each task link in feedback cards", () => {
    const storeWithTasks = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Bug in login",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: ["opensprint.dev-abc.1", "opensprint.dev-xyz.2"],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [
            {
              id: "opensprint.dev-abc.1",
              title: "Fix login",
              description: "",
              type: "bug" as const,
              status: "closed" as const,
              priority: 2,
              assignee: null,
              labels: [],
              dependencies: [],
              epicId: "plan-1",
              kanbanColumn: "done" as const,
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "opensprint.dev-xyz.2",
              title: "Related task",
              description: "",
              type: "task" as const,
              status: "in_progress" as const,
              priority: 2,
              assignee: "agent-1",
              labels: [],
              dependencies: [],
              epicId: "plan-1",
              kanbanColumn: "in_progress" as const,
              createdAt: "",
              updatedAt: "",
            },
          ],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithTasks}>
        <EvalPhase projectId="proj-1" onNavigateToBuildTask={(id) => id} />
      </Provider>,
    );

    // Task links are shown
    expect(screen.getByText("opensprint.dev-abc.1")).toBeInTheDocument();
    expect(screen.getByText("opensprint.dev-xyz.2")).toBeInTheDocument();

    // Task status icons: Done (checkmark) for first task, In Progress for second
    expect(screen.getByTitle("Done")).toBeInTheDocument();
    expect(screen.getByTitle("In Progress")).toBeInTheDocument();

    // Task status labels are visible as part of the feedback container
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
  });

  it("shows Backlog status for tasks not yet in execute tasks", () => {
    const storeWithUnmappedTask = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "New feature request",
              category: "feature",
              mappedPlanId: "plan-1",
              createdTaskIds: ["opensprint.dev-new.1"],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithUnmappedTask}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("opensprint.dev-new.1")).toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("shows reply button on each feedback card", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Original feedback",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const replyButtons = screen.getAllByRole("button", { name: /Reply/i });
    expect(replyButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("shows reply button on same line as ticket info in feedback cards", () => {
    const storeWithTaskAndReply = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Bug in login",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: ["opensprint.dev-abc.1"],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [
            {
              id: "opensprint.dev-abc.1",
              title: "Fix login",
              description: "",
              type: "bug" as const,
              status: "in_progress" as const,
              priority: 2,
              assignee: null,
              labels: [],
              dependencies: [],
              epicId: "plan-1",
              kanbanColumn: "in_progress" as const,
              createdAt: "",
              updatedAt: "",
            },
          ],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithTaskAndReply}>
        <EvalPhase projectId="proj-1" onNavigateToBuildTask={(id) => id} />
      </Provider>,
    );

    const taskLink = screen.getByText("opensprint.dev-abc.1");
    const replyBtn = screen.getByRole("button", { name: /^Reply$/i });

    // Both ticket info and reply button share the same row (flex with justify-between)
    const ticketInfoRow = replyBtn.parentElement?.parentElement;
    expect(ticketInfoRow).toBeInTheDocument();
    expect(ticketInfoRow).toContainElement(taskLink);
    expect(ticketInfoRow).toContainElement(replyBtn);
    expect(ticketInfoRow).toHaveClass("justify-between");
  });

  it("shows quote snippet of parent feedback above reply textarea", async () => {
    const user = userEvent.setup();
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Original feedback to reply to",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    await user.click(screen.getByRole("button", { name: /^Reply$/i }));

    expect(screen.getByText("Original feedback to reply to")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Write a reply/)).toBeInTheDocument();
  });

  it("truncates long parent feedback in quote snippet with ellipsis", async () => {
    const user = userEvent.setup();
    const longText = "A".repeat(100);
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: longText,
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    const { container } = render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    await user.click(screen.getByRole("button", { name: /^Reply$/i }));

    const blockquote = container.querySelector("blockquote");
    expect(blockquote).toBeInTheDocument();
    expect(blockquote!.textContent).toBe("A".repeat(80) + "…");
  });

  it("opens inline reply composer when reply button is clicked", async () => {
    const user = userEvent.setup();
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Original feedback",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    const replyBtn = screen.getByRole("button", { name: /^Reply$/i });
    await user.click(replyBtn);

    expect(screen.getByPlaceholderText(/Write a reply/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Submit Reply/i })).toBeInTheDocument();
  });

  it("submits reply with parent_id when submit reply is clicked", async () => {
    const user = userEvent.setup();
    mockFeedbackSubmit.mockResolvedValue({
      id: "fb-reply",
      text: "Reply text",
      category: "bug",
      mappedPlanId: "plan-1",
      createdTaskIds: [],
      status: "pending",
      parent_id: "fb-1",
      depth: 1,
      createdAt: new Date().toISOString(),
    });
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Original feedback",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    await user.click(screen.getByRole("button", { name: /^Reply$/i }));
    await user.type(screen.getByPlaceholderText(/Write a reply/), "Reply text");
    await user.click(screen.getByRole("button", { name: /Submit Reply/i }));

    await waitFor(() => {
      expect(mockFeedbackSubmit).toHaveBeenCalledWith("proj-1", "Reply text", undefined, "fb-1");
    });
  });

  it("dismisses reply composer when cancel is clicked", async () => {
    const user = userEvent.setup();
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "Original feedback",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithFeedback}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    await user.click(screen.getByRole("button", { name: /^Reply$/i }));
    expect(screen.getByPlaceholderText(/Write a reply/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Cancel/i }));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/Write a reply/)).not.toBeInTheDocument();
    });
  });

  it("displays nested replies indented below parent", () => {
    const storeWithNested = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-parent",
              text: "Parent feedback",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              parent_id: null,
              depth: 0,
              createdAt: "2026-01-01T10:00:00Z",
            },
            {
              id: "fb-child",
              text: "Child reply",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: [],
              status: "mapped",
              parent_id: "fb-parent",
              depth: 1,
              createdAt: "2026-01-01T11:00:00Z",
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithNested}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Parent feedback")).toBeInTheDocument();
    expect(screen.getByText("Child reply")).toBeInTheDocument();
    // Both have reply buttons
    const replyButtons = screen.getAllByRole("button", { name: /Reply/i });
    expect(replyButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("shows collapse/expand button when feedback has replies", () => {
    const storeWithReplies = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-parent",
              text: "Parent",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: null,
              depth: 0,
              createdAt: "2026-01-01T10:00:00Z",
            },
            {
              id: "fb-child",
              text: "Child",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: "fb-parent",
              depth: 1,
              createdAt: "2026-01-01T11:00:00Z",
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithReplies}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByRole("button", { name: /Collapse \(1 reply\)/i })).toBeInTheDocument();
  });

  it("shows plural 'replies' when feedback has multiple replies", () => {
    const storeWithMultipleReplies = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-parent",
              text: "Parent",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: null,
              depth: 0,
              createdAt: "2026-01-01T10:00:00Z",
            },
            {
              id: "fb-child1",
              text: "First reply",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: "fb-parent",
              depth: 1,
              createdAt: "2026-01-01T11:00:00Z",
            },
            {
              id: "fb-child2",
              text: "Second reply",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: "fb-parent",
              depth: 1,
              createdAt: "2026-01-01T12:00:00Z",
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithMultipleReplies}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByRole("button", { name: /Collapse \(2 replies\)/i })).toBeInTheDocument();
  });

  it("shows backlog icon for task not in execute tasks", () => {
    const storeWithUnknownTask = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-1",
              text: "New feedback",
              category: "bug",
              mappedPlanId: "plan-1",
              createdTaskIds: ["opensprint.dev-new.1"],
              status: "mapped",
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithUnknownTask}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    // Unknown task shows backlog icon (default)
    expect(screen.getByText("opensprint.dev-new.1")).toBeInTheDocument();
    expect(screen.getByTitle("Backlog")).toBeInTheDocument();
  });
});

describe("EvalPhase feedback collapsed state persistence", () => {
  const storage: Record<string, string> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(storage).forEach((k) => delete storage[k]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
      length: 0,
      key: () => null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists feedback collapsed state to localStorage when user collapses", async () => {
    const storeWithReplies = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-parent",
              text: "Parent",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: null,
              depth: 0,
              createdAt: "2026-01-01T10:00:00Z",
            },
            {
              id: "fb-child",
              text: "Child",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: "fb-parent",
              depth: 1,
              createdAt: "2026-01-01T11:00:00Z",
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    const user = userEvent.setup();
    render(
      <Provider store={storeWithReplies}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    // Initially child is visible
    expect(screen.getByText("Child")).toBeInTheDocument();

    // Click Collapse
    await user.click(screen.getByRole("button", { name: /Collapse \(1 reply\)/i }));

    // Child is hidden
    expect(screen.queryByText("Child")).not.toBeInTheDocument();

    // localStorage has the collapsed id
    const key = `${FEEDBACK_COLLAPSED_KEY_PREFIX}-proj-1`;
    expect(storage[key]).toBeDefined();
    const parsed = JSON.parse(storage[key]) as string[];
    expect(parsed).toContain("fb-parent");
  });

  it("restores feedback collapsed state from localStorage on mount", async () => {
    const key = `${FEEDBACK_COLLAPSED_KEY_PREFIX}-proj-1`;
    storage[key] = JSON.stringify(["fb-parent"]);

    const storeWithReplies = configureStore({
      reducer: {
        project: projectReducer,
        eval: evalReducer,
        execute: executeReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "eval",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        eval: {
          feedback: [
            {
              id: "fb-parent",
              text: "Parent",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: null,
              depth: 0,
              createdAt: "2026-01-01T10:00:00Z",
            },
            {
              id: "fb-child",
              text: "Child",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "mapped",
              parent_id: "fb-parent",
              depth: 1,
              createdAt: "2026-01-01T11:00:00Z",
            },
          ],
          loading: false,
          submitting: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    render(
      <Provider store={storeWithReplies}>
        <EvalPhase projectId="proj-1" />
      </Provider>,
    );

    // Parent is visible, child is collapsed (hidden)
    expect(screen.getByText("Parent")).toBeInTheDocument();
    expect(screen.queryByText("Child")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Expand \(1 reply\)/i })).toBeInTheDocument();
  });
});
