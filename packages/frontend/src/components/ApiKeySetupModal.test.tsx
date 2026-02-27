import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiKeySetupModal } from "./ApiKeySetupModal";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    env: {
      validateKey: vi.fn(),
      saveKey: vi.fn(),
      setGlobalSettings: vi.fn(),
    },
  },
}));

describe("ApiKeySetupModal", () => {
  const onComplete = vi.fn();
  const onCancel = vi.fn();
  const intendedRoute = "/projects/create-new";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders modal with title and body copy", () => {
    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    expect(screen.getByText("Enter agent API key")).toBeInTheDocument();
    expect(
      screen.getByText(/At least one agent API key is required to use Open Sprint/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Custom\/CLI.*own agent/)
    ).toBeInTheDocument();
  });

  it("shows provider dropdown with Claude, Cursor, Custom/CLI", () => {
    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    const select = screen.getByTestId("api-key-provider-select");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("claude");
    expect(screen.getByRole("option", { name: "Claude" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cursor" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custom/CLI" })).toBeInTheDocument();
  });

  it("shows password input when Claude or Cursor selected", () => {
    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    expect(screen.getByTestId("api-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-input")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("api-key-eye-toggle")).toBeInTheDocument();
  });

  it("hides key input when Custom/CLI selected", async () => {
    const user = userEvent.setup();
    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    await user.selectOptions(
      screen.getByTestId("api-key-provider-select"),
      "Custom/CLI"
    );

    expect(screen.queryByTestId("api-key-input")).not.toBeInTheDocument();
  });

  it("toggles password visibility with eye icon", async () => {
    const user = userEvent.setup();
    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    const input = screen.getByTestId("api-key-input");
    const eyeToggle = screen.getByTestId("api-key-eye-toggle");

    expect(input).toHaveAttribute("type", "password");
    await user.click(eyeToggle);
    expect(input).toHaveAttribute("type", "text");
    await user.click(eyeToggle);
    expect(input).toHaveAttribute("type", "password");
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("Custom/CLI Save calls setGlobalSettings and onComplete", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.setGlobalSettings).mockResolvedValue({ useCustomCli: true });

    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    await user.selectOptions(
      screen.getByTestId("api-key-provider-select"),
      "Custom/CLI"
    );
    await user.click(screen.getByTestId("api-key-save-button"));

    expect(api.env.setGlobalSettings).toHaveBeenCalledWith({ useCustomCli: true });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(api.env.validateKey).not.toHaveBeenCalled();
    expect(api.env.saveKey).not.toHaveBeenCalled();
  });

  it("Claude Save validates then saves and calls onComplete", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey).mockResolvedValue({ valid: true });
    vi.mocked(api.env.saveKey).mockResolvedValue({ saved: true });

    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    await user.type(screen.getByTestId("api-key-input"), "sk-ant-test-key");
    await user.click(screen.getByTestId("api-key-save-button"));

    expect(api.env.validateKey).toHaveBeenCalledWith("claude", "sk-ant-test-key");
    expect(api.env.saveKey).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-ant-test-key");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Cursor Save validates then saves and calls onComplete", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey).mockResolvedValue({ valid: true });
    vi.mocked(api.env.saveKey).mockResolvedValue({ saved: true });

    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    await user.selectOptions(
      screen.getByTestId("api-key-provider-select"),
      "Cursor"
    );
    await user.type(screen.getByTestId("api-key-input"), "key_cursor_test");
    await user.click(screen.getByTestId("api-key-save-button"));

    expect(api.env.validateKey).toHaveBeenCalledWith("cursor", "key_cursor_test");
    expect(api.env.saveKey).toHaveBeenCalledWith("CURSOR_API_KEY", "key_cursor_test");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("shows error when validation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey).mockResolvedValue({
      valid: false,
      error: "Invalid API key",
    });

    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    await user.type(screen.getByTestId("api-key-input"), "bad-key");
    await user.click(screen.getByTestId("api-key-save-button"));

    expect(screen.getByText("Invalid API key")).toBeInTheDocument();
    expect(api.env.saveKey).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("shows error when Save is clicked with empty key for Claude", async () => {
    const user = userEvent.setup();

    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    // Save button should be disabled when empty, but let's ensure we don't call API
    const saveBtn = screen.getByTestId("api-key-save-button");
    expect(saveBtn).toBeDisabled();
  });

  it("Save button enabled when key entered for Claude", async () => {
    const user = userEvent.setup();

    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    expect(screen.getByTestId("api-key-save-button")).toBeDisabled();
    await user.type(screen.getByTestId("api-key-input"), "sk-ant-x");
    expect(screen.getByTestId("api-key-save-button")).not.toBeDisabled();
  });

  it("Save button always enabled for Custom/CLI", async () => {
    const user = userEvent.setup();

    render(
      <ApiKeySetupModal
        onComplete={onComplete}
        onCancel={onCancel}
        intendedRoute={intendedRoute}
      />
    );

    await user.selectOptions(
      screen.getByTestId("api-key-provider-select"),
      "Custom/CLI"
    );
    expect(screen.getByTestId("api-key-save-button")).not.toBeDisabled();
  });
});
