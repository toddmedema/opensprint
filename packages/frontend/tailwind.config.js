import typography from "@tailwindcss/typography";

// Keep public hex tokens compatible with Tailwind slash-opacity modifiers.
// color-mix is supported by the app's Chromium/Electron runtime.
const tokenColor =
  (name) =>
  ({ opacityValue }) =>
    opacityValue === undefined
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: ["selector", 'html[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        /* Theme-aware tokens (unified --ui-* design token contract) */
        theme: {
          accent: tokenColor("--ui-accent-primary"),
          bg: tokenColor("--ui-surface-page"),
          "bg-elevated": tokenColor("--ui-surface-raised"),
          text: tokenColor("--ui-text-primary"),
          muted: tokenColor("--ui-text-secondary"),
          surface: tokenColor("--ui-surface-raised"),
          border: tokenColor("--ui-stroke-soft"),
          "border-subtle": tokenColor("--ui-stroke-subtle"),
          ring: tokenColor("--ui-stroke-strong"),
          "input-bg": tokenColor("--ui-surface-raised"),
          "input-text": tokenColor("--ui-text-primary"),
          "input-placeholder": tokenColor("--ui-text-placeholder"),
          "code-bg": tokenColor("--ui-surface-code"),
          "code-text": tokenColor("--ui-text-code"),
          overlay: tokenColor("--ui-overlay-default"),
          "surface-muted": tokenColor("--ui-surface-muted"),
          "graph-edge": tokenColor("--ui-graph-edge"),
          "graph-edge-critical": tokenColor("--ui-graph-edge-critical"),
          /* Semantic tokens (--ui-* design token contract) */
          error: tokenColor("--ui-status-error-text"),
          "error-bg": tokenColor("--ui-status-error-bg"),
          "error-text": tokenColor("--ui-status-error-text"),
          "error-border": tokenColor("--ui-status-error-border"),
          "error-solid": tokenColor("--ui-status-error"),
          "error-solid-hover": tokenColor("--ui-status-error-solid-hover"),
          "success-bg": tokenColor("--ui-status-success-bg"),
          "success-text": tokenColor("--ui-status-success-text"),
          "success-border": tokenColor("--ui-status-success-border"),
          "success-solid": tokenColor("--ui-status-success"),
          "success-muted": tokenColor("--ui-status-success-muted"),
          "warning-bg": tokenColor("--ui-status-warning-bg"),
          "warning-text": tokenColor("--ui-status-warning-text"),
          "warning-border": tokenColor("--ui-status-warning-border"),
          "warning-solid": tokenColor("--ui-status-warning"),
          "info-bg": tokenColor("--ui-accent-tint"),
          "info-text": tokenColor("--ui-status-info-text"),
          "info-border": tokenColor("--ui-status-info-border"),
          "info-solid": tokenColor("--ui-accent-primary"),
          "notification-error": tokenColor("--ui-notification-error"),
          "notification-warning": tokenColor("--ui-notification-warning"),
          "notification-info": tokenColor("--ui-notification-info"),
          "notification-success": tokenColor("--ui-notification-success"),
          "feedback-bug-bg": tokenColor("--ui-feedback-bug-bg"),
          "feedback-bug-text": tokenColor("--ui-feedback-bug-text"),
          "feedback-feature-bg": tokenColor("--ui-feedback-feature-bg"),
          "feedback-feature-text": tokenColor("--ui-feedback-feature-text"),
          "feedback-ux-bg": tokenColor("--ui-feedback-ux-bg"),
          "feedback-ux-text": tokenColor("--ui-feedback-ux-text"),
          "feedback-scope-bg": tokenColor("--ui-feedback-scope-bg"),
          "feedback-scope-text": tokenColor("--ui-feedback-scope-text"),
          "status-backlog": tokenColor("--ui-status-indicator-backlog"),
          "status-ready": tokenColor("--ui-status-info"),
          "status-in-progress": tokenColor("--ui-status-indicator-in-progress"),
          "status-in-review": tokenColor("--ui-status-indicator-in-review"),
          "status-done": tokenColor("--ui-status-success"),
          "status-blocked": tokenColor("--ui-status-error"),
        },
        surface: {
          page: tokenColor("--ui-surface-page"),
          raised: tokenColor("--ui-surface-raised"),
          muted: tokenColor("--ui-surface-muted"),
          code: tokenColor("--ui-surface-code"),
        },
        stroke: {
          soft: tokenColor("--ui-stroke-soft"),
          strong: tokenColor("--ui-stroke-strong"),
          focus: tokenColor("--ui-stroke-focus"),
        },
        accent: {
          primary: tokenColor("--ui-accent-primary"),
          strong: tokenColor("--ui-accent-strong"),
          tint: tokenColor("--ui-accent-tint"),
        },
        status: {
          info: tokenColor("--ui-status-info"),
          success: tokenColor("--ui-status-success"),
          warning: tokenColor("--ui-status-warning"),
          error: tokenColor("--ui-status-error"),
        },
        brand: {
          50: "#edf5ff",
          100: "#d9eaff",
          200: "#bdd9ff",
          300: "#8abfff",
          400: "#5aa5ff",
          500: "#2f89f1",
          600: "#0071e3",
          700: "#005bb5",
          800: "#00488e",
          900: "#003c75",
          950: "#00264a",
        },
      },
      fontFamily: {
        sans: [
          "SF Pro Text",
          "SF Pro Display",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Menlo", "monospace"],
      },
      keyframes: {
        "slide-up-fade": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-out-fade": {
          "0%": { opacity: "1", transform: "translateY(0)" },
          "100%": { opacity: "0", transform: "translateY(-8px)" },
        },
        "slide-in-right": {
          "0%": { transform: "translateX(100%)" },
          "100%": { transform: "translateX(0)" },
        },
        "slide-in-left": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "logo-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },
      animation: {
        "slide-up-fade": "slide-up-fade 0.2s ease-out",
        "slide-out-fade": "slide-out-fade 0.2s ease-out forwards",
        "slide-in-right": "slide-in-right 0.2s ease-out",
        "slide-in-left": "slide-in-left 0.2s ease-out",
        "fade-in": "fade-in 0.15s ease-out",
        "logo-pulse": "logo-pulse 1.2s ease-in-out infinite",
        "logo-pulse-slow": "logo-pulse 3.6s ease-in-out infinite",
      },
    },
  },
  plugins: [typography],
};
