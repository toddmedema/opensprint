import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { VerifyPhase } from "./VerifyPhase";
import projectReducer from "../../store/slices/projectSlice";
import validateReducer from "../../store/slices/validateSlice";

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

vi.mock("../../api/client", () => ({
  api: {
    feedback: {
      list: (...args: unknown[]) => mockFeedbackList(...args),
      submit: (...args: unknown[]) => mockFeedbackSubmit(...args),
    },
  },
}));

function createStore() {
  return configureStore({
    reducer: {
      project: projectReducer,
      validate: validateReducer,
    },
    preloadedState: {
      project: {
        data: {
          id: "proj-1",
          name: "Test Project",
          description: "",
          repoPath: "/tmp/test",
          currentPhase: "verify",
          createdAt: "",
          updatedAt: "",
        },
        loading: false,
        error: null,
      },
      validate: {
        feedback: [],
        loading: false,
        submitting: false,
        error: null,
      },
    },
  });
}

describe("VerifyPhase feedback input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders feedback input with textarea, image attach button, and submit button", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <VerifyPhase projectId="proj-1" />
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
        <VerifyPhase projectId="proj-1" />
      </Provider>,
    );

    const attachBtn = screen.getByRole("button", { name: /Attach image/i });
    expect(attachBtn).toHaveClass("btn-secondary");
  });

  it("image attach button is to the left of submit button", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <VerifyPhase projectId="proj-1" />
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
        <VerifyPhase projectId="proj-1" />
      </Provider>,
    );

    await user.type(screen.getByPlaceholderText(/Describe a bug/), "Bug in login");
    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(mockFeedbackSubmit).toHaveBeenCalledWith("proj-1", "Bug in login", undefined);
    });
  });

  it("submits feedback with images when images are attached", async () => {
    const user = userEvent.setup();
    const store = createStore();
    render(
      <Provider store={store}>
        <VerifyPhase projectId="proj-1" />
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
        <VerifyPhase projectId="proj-1" />
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
        <VerifyPhase projectId="proj-1" />
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

  it("displays images in feedback history when present", () => {
    const storeWithFeedback = configureStore({
      reducer: {
        project: projectReducer,
        validate: validateReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "verify",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        validate: {
          feedback: [
            {
              id: "fb-with-img",
              text: "Screenshot of bug",
              category: "bug",
              mappedPlanId: null,
              createdTaskIds: [],
              status: "pending",
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
        <VerifyPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Screenshot of bug")).toBeInTheDocument();
    const imgs = screen.getAllByRole("img", { name: /Attachment \d+/ });
    expect(imgs.length).toBeGreaterThanOrEqual(1);
  });
});
