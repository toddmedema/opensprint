import React from "react";
import { Link } from "react-router-dom";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches uncaught render errors in the tree and shows a fallback UI
 * so the app does not unmount entirely.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          className="flex min-h-screen flex-col items-center justify-center gap-4 bg-theme-surface p-6 text-theme-text"
          role="alert"
        >
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="max-w-md text-center text-theme-text-muted">
            An unexpected error occurred. You can try reloading the page or
            return to the home page.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-theme-primary px-4 py-2 text-theme-primary-inverse hover:opacity-90"
            >
              Reload
            </button>
            <Link
              to="/"
              className="rounded-lg border border-theme-border px-4 py-2 hover:bg-theme-surface-muted"
            >
              Go home
            </Link>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
