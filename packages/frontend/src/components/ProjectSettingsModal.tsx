import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useImperativeHandle,
  forwardRef,
  lazy,
  Suspense,
} from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useSearchParams, Link } from "react-router-dom";
import { FolderBrowser } from "./FolderBrowser";
import { CloseButton } from "./CloseButton";
import { ModelSelect } from "./ModelSelect";
import { SaveIndicator } from "./SaveIndicator";
import { SettingsTopBar } from "./settings/SettingsTopBar";
import { SettingsSubTabsBar, type SettingsSubTab } from "./settings/SettingsSubTabsBar";
import { WorkflowSettingsContent } from "./settings/WorkflowSettingsContent";
import { api } from "../api/client";
import type {
  Project,
  ProjectSettings,
  AgentType,
  AiAutonomyLevel,
  DeploymentMode,
  GitWorkingMode,
  MergeStrategy,
  ReviewAngle,
  ReviewMode,
  SelfImprovementFrequency,
  UnknownScopeStrategy,
} from "@opensprint/shared";
import {
  AI_AUTONOMY_LEVELS,
  DEFAULT_AI_AUTONOMY_LEVEL,
  DEFAULT_REVIEW_MODE,
  getDeploymentTargetsForUi,
  AUTO_DEPLOY_TRIGGER_OPTIONS,
  type AutoDeployTrigger,
} from "@opensprint/shared";
import { MIN_SAVE_SPINNER_MS, SETTINGS_HELP_CONTAINER_CLASS } from "../lib/constants";

const DEFAULT_LMSTUDIO_BASE_URL = "http://localhost:1234";

interface ProjectSettingsModalProps {
  project: Project;
  onClose: () => void;
  onSaved?: () => void;
  /** When true, render as full-screen page instead of modal overlay */
  fullScreen?: boolean;
  /** When fullScreen, parent renders tabs in topbar; pass these to control tab state externally */
  activeTab?: SettingsSubTab;
  onTabChange?: (tab: SettingsSubTab) => void;
  onSaveStatusChange?: (status: "saving" | "saved") => void;
}

const AgentsMdSection = lazy(() =>
  import("./AgentsMdSection").then((module) => ({ default: module.AgentsMdSection }))
);

function AgentsSectionFallback() {
  return (
    <div className="flex items-center gap-2 py-4" data-testid="agents-md-section-loading">
      <div className="w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      <span className="text-sm text-theme-muted">Loading agent instructions...</span>
    </div>
  );
}

export interface ProjectSettingsModalRef {
  persist: () => Promise<void>;
}

const TAB_PARAM = "tab";

function parseTabFromSearch(search: string): SettingsSubTab | null {
  const params = new URLSearchParams(search);
  const t = params.get(TAB_PARAM);
  const valid: SettingsSubTab[] = ["basics", "agents", "workflow", "deployment", "hil", "team"];
  if (t && valid.includes(t as SettingsSubTab)) return t as SettingsSubTab;
  return null;
}

export const ProjectSettingsModal = forwardRef<ProjectSettingsModalRef, ProjectSettingsModalProps>(
  function ProjectSettingsModal(
    {
      project,
      onClose,
      onSaved,
      fullScreen,
      activeTab: externalActiveTab,
      onTabChange: externalOnTabChange,
      onSaveStatusChange,
    },
    ref
  ) {
    const [searchParams, setSearchParams] = useSearchParams();
    const tabFromUrl = fullScreen ? parseTabFromSearch(searchParams.toString()) : null;
    const [internalActiveTab, setInternalActiveTab] = useState<SettingsSubTab>(
      tabFromUrl ?? "basics"
    );

    const tabsControlledExternally = Boolean(
      fullScreen && externalActiveTab != null && externalOnTabChange
    );
    const activeTab = tabsControlledExternally ? externalActiveTab! : internalActiveTab;
    const setActiveTab = tabsControlledExternally ? externalOnTabChange! : setInternalActiveTab;

    // Sync URL -> state when fullScreen and not externally controlled (e.g. browser back/forward)
    useEffect(() => {
      if (
        fullScreen &&
        !tabsControlledExternally &&
        tabFromUrl &&
        tabFromUrl !== internalActiveTab
      ) {
        setInternalActiveTab(tabFromUrl);
      }
    }, [fullScreen, tabsControlledExternally, tabFromUrl, internalActiveTab]);

    const [saving, setSaving] = useState(false);
    const saveGenerationRef = useRef(0);
    const saveCompleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Tracks latest intended reviewAngles so tab switch / close persist uses it before state flushes (fixes single-angle not saving). */
    const lastReviewAnglesRef = useRef<ProjectSettings["reviewAngles"] | undefined>(undefined);
    const loadRequestRef = useRef(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showFolderBrowser, setShowFolderBrowser] = useState(false);
    /** Inline "add new env var" row state per target (key: custom-0, expo-staging, etc.) */
    const [newEnvRow, setNewEnvRow] = useState<Record<string, { key: string; value: string }>>({});
    const saveStatus = saving ? "saving" : "saved";

    useEffect(() => {
      if (onSaveStatusChange) onSaveStatusChange(saveStatus);
    }, [saveStatus, onSaveStatusChange]);

    useEffect(() => {
      if (saveStatus !== "saving") return;
      const handler = (e: BeforeUnloadEvent) => {
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    }, [saveStatus]);

    useEffect(() => {
      return () => {
        if (saveCompleteTimeoutRef.current) {
          clearTimeout(saveCompleteTimeoutRef.current);
        }
        if (pollTimeoutRef.current) {
          clearTimeout(pollTimeoutRef.current);
        }
      };
    }, []);

    // Project basics
    const [name, setName] = useState(project.name);
    const [repoPath, setRepoPath] = useState(project.repoPath);

    // Settings
    const [settings, setSettings] = useState<ProjectSettings | null>(null);

    // API key status (for agents tab - to show "configure in Settings" when keys missing)
    // anthropic/cursor/openai/google derived from global store only; claudeCli from env (CLI binary availability)
    const [envKeys, setEnvKeys] = useState<{
      anthropic: boolean;
      cursor: boolean;
      openai: boolean;
      google: boolean;
      claudeCli: boolean;
      cursorCli: boolean;
    } | null>(null);
    const [modelRefreshTrigger] = useState(0);
    const [cursorCliInstalling, setCursorCliInstalling] = useState(false);
    const [cursorCliInstallResult, setCursorCliInstallResult] = useState<{
      success: boolean;
      message: string;
    } | null>(null);

    // Advanced section (Agent Instructions) in Agent Config — collapsed by default
    const [advancedExpanded, setAdvancedExpanded] = useState(false);

    const clearPollTimeout = useCallback(() => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    }, []);

    const loadSettings = useCallback(
      async (options?: { preserveSpinner?: boolean }) => {
        const preserveSpinner = options?.preserveSpinner !== false;
        const requestId = ++loadRequestRef.current;
        if (preserveSpinner) {
          setLoading(true);
        }
        setError(null);
        try {
          const data = await api.projects.getSettings(project.id);
          if (loadRequestRef.current !== requestId) return;
          setSettings(data);
          lastReviewAnglesRef.current = data.reviewAngles;
          clearPollTimeout();
          if (data.gitRuntimeStatus?.refreshing) {
            pollTimeoutRef.current = setTimeout(() => {
              void loadSettings({ preserveSpinner: false });
            }, 1000);
          }
        } catch (err) {
          if (loadRequestRef.current !== requestId) return;
          setError(err instanceof Error ? err.message : "Failed to load settings");
        } finally {
          if (loadRequestRef.current === requestId && preserveSpinner) {
            setLoading(false);
          }
        }
      },
      [clearPollTimeout, project.id]
    );

    useEffect(() => {
      void loadSettings({ preserveSpinner: true });
      return () => {
        loadRequestRef.current += 1;
        clearPollTimeout();
      };
    }, [clearPollTimeout, loadSettings]);

    // Fetch API key status when agents tab is active.
    // API key warning (claude/cursor/openai/google) uses global store only; claudeCli uses env for CLI availability.
    useEffect(() => {
      if (activeTab !== "agents") return;
      Promise.all([api.globalSettings.get(), api.env.getKeys()])
        .then(([global, env]) => {
          const apiKeys = global.apiKeys;
          const anthropic = (apiKeys?.ANTHROPIC_API_KEY?.length ?? 0) > 0;
          const cursor = (apiKeys?.CURSOR_API_KEY?.length ?? 0) > 0;
          const openai = (apiKeys?.OPENAI_API_KEY?.length ?? 0) > 0;
          const google = (apiKeys?.GOOGLE_API_KEY?.length ?? 0) > 0;
          setEnvKeys({ anthropic, cursor, openai, google, claudeCli: env.claudeCli, cursorCli: env.cursorCli });
        })
        .catch(() => setEnvKeys(null));
    }, [activeTab]);

    const simpleComplexityAgent = useMemo(
      () =>
        settings?.simpleComplexityAgent ?? {
          type: "cursor" as AgentType,
          model: null,
          cliCommand: null,
        },
      [settings?.simpleComplexityAgent]
    );
    const complexComplexityAgent = useMemo(
      () =>
        settings?.complexComplexityAgent ?? {
          type: "cursor" as AgentType,
          model: null,
          cliCommand: null,
        },
      [settings?.complexComplexityAgent]
    );
    const deployment = useMemo(
      () => settings?.deployment ?? { mode: "custom" as DeploymentMode },
      [settings?.deployment]
    );
    const aiAutonomyLevel = settings?.aiAutonomyLevel ?? DEFAULT_AI_AUTONOMY_LEVEL;
    const gitWorkingMode = settings?.gitWorkingMode ?? "worktree";
    const mergeStrategy = settings?.mergeStrategy ?? "per_task";
    type PersistOverrides = Partial<{
      name: string;
      repoPath: string;
      simpleComplexityAgent: typeof simpleComplexityAgent;
      complexComplexityAgent: typeof complexComplexityAgent;
      deployment: typeof deployment;
      aiAutonomyLevel: AiAutonomyLevel;
      gitWorkingMode: GitWorkingMode;
      mergeStrategy: MergeStrategy;
      worktreeBaseBranch: string;
      testCommand: string | null;
      reviewMode: ReviewMode;
      reviewAngles: ReviewAngle[];
      includeGeneralReview?: boolean;
      maxConcurrentCoders: number;
      unknownScopeStrategy: UnknownScopeStrategy;
      enableHumanTeammates?: boolean;
      teamMembers: Array<{ id: string; name: string }>;
      selfImprovementFrequency?: SelfImprovementFrequency;
    }>;

    const persistSettings = useCallback(
      async (notifyOnComplete?: boolean, overrides?: PersistOverrides) => {
        if (loading || !settings) return;
        const effName = overrides?.name ?? name;
        const effRepoPath = overrides?.repoPath ?? repoPath;
        const effSimple = overrides?.simpleComplexityAgent ?? simpleComplexityAgent;
        const effComplex = overrides?.complexComplexityAgent ?? complexComplexityAgent;
        const effDeployment = overrides?.deployment ?? deployment;
        const effAiAutonomy = overrides?.aiAutonomyLevel ?? aiAutonomyLevel;
        const effGitMode = overrides?.gitWorkingMode ?? gitWorkingMode;
        const effMergeStrategy = overrides?.mergeStrategy ?? mergeStrategy;
        const effEnableHumanTeammates = overrides?.enableHumanTeammates ?? settings?.enableHumanTeammates ?? false;
        const effTeamMembers = overrides?.teamMembers ?? settings?.teamMembers ?? [];
        const effSettings = overrides ? { ...settings } : settings;
        if (effSimple.type === "custom" && !(effSimple.cliCommand ?? "").trim()) return;
        if (effComplex.type === "custom" && !(effComplex.cliCommand ?? "").trim()) return;
        setSaving(true);
        setError(null);
        saveGenerationRef.current += 1;
        const startTime = Date.now();
        const completedGeneration = saveGenerationRef.current;
        try {
          await Promise.all([
            api.projects.update(project.id, { name: effName, repoPath: effRepoPath }),
            api.projects.updateSettings(project.id, {
              simpleComplexityAgent: {
                type: effSimple.type,
                model: effSimple.model || null,
                cliCommand: effSimple.cliCommand || null,
                ...(effSimple.type === "lmstudio" && {
                  baseUrl: effSimple.baseUrl || DEFAULT_LMSTUDIO_BASE_URL,
                }),
              },
              complexComplexityAgent: {
                type: effComplex.type,
                model: effComplex.model || null,
                cliCommand: effComplex.cliCommand || null,
                ...(effComplex.type === "lmstudio" && {
                  baseUrl: effComplex.baseUrl || DEFAULT_LMSTUDIO_BASE_URL,
                }),
              },
              deployment: {
                mode: effDeployment.mode,
                expoConfig:
                  effDeployment.mode === "expo"
                    ? {
                        channel: effDeployment.expoConfig?.channel ?? "preview",
                        projectId:
                          effDeployment.expoConfig?.projectId ??
                          effDeployment.easProjectId ??
                          undefined,
                      }
                    : undefined,
                customCommand: effDeployment.customCommand ?? undefined,
                webhookUrl: effDeployment.webhookUrl ?? undefined,
                rollbackCommand: effDeployment.rollbackCommand ?? undefined,
                targets: effDeployment.targets,
                autoResolveFeedbackOnTaskCompletion:
                  effDeployment.autoResolveFeedbackOnTaskCompletion ?? false,
              },
              aiAutonomyLevel: effAiAutonomy,
              testCommand: overrides?.testCommand ?? effSettings?.testCommand ?? undefined,
              reviewMode: overrides?.reviewMode ?? effSettings?.reviewMode ?? DEFAULT_REVIEW_MODE,
              // Send [] when empty so backend receives it (undefined is omitted from JSON and would keep old value)
              reviewAngles:
                overrides?.reviewAngles ??
                lastReviewAnglesRef.current ??
                effSettings?.reviewAngles ??
                [],
              includeGeneralReview: overrides?.includeGeneralReview ?? effSettings?.includeGeneralReview ?? undefined,
              maxConcurrentCoders:
                effGitMode === "branches"
                  ? 1
                  : (overrides?.maxConcurrentCoders ?? effSettings?.maxConcurrentCoders ?? 1),
              unknownScopeStrategy:
                overrides?.unknownScopeStrategy ??
                effSettings?.unknownScopeStrategy ??
                "optimistic",
              gitWorkingMode: effGitMode,
              mergeStrategy: effMergeStrategy,
              worktreeBaseBranch:
                overrides?.worktreeBaseBranch ?? effSettings?.worktreeBaseBranch ?? "main",
              enableHumanTeammates: effEnableHumanTeammates,
              teamMembers: effTeamMembers,
              selfImprovementFrequency:
                overrides?.selfImprovementFrequency ??
                effSettings?.selfImprovementFrequency ??
                "never",
            }),
          ]);
          if (notifyOnComplete) onSaved?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to save settings");
        } finally {
          const elapsed = Date.now() - startTime;
          const remaining = Math.max(0, MIN_SAVE_SPINNER_MS - elapsed);
          const run = () => {
            if (saveGenerationRef.current === completedGeneration) {
              setSaving(false);
            }
          };
          if (remaining > 0) {
            saveCompleteTimeoutRef.current = setTimeout(run, remaining);
          } else {
            run();
          }
        }
      },
      [
        project.id,
        name,
        repoPath,
        settings,
        simpleComplexityAgent,
        complexComplexityAgent,
        deployment,
        aiAutonomyLevel,
        gitWorkingMode,
        mergeStrategy,
        loading,
        onSaved,
      ]
    );

    const enableHumanTeammates = settings?.enableHumanTeammates ?? false;
    const teamMembers = settings?.teamMembers ?? [];

    const setEnableHumanTeammates = (value: boolean) => {
      setSettings((s) => (s ? { ...s, enableHumanTeammates: value } : null));
      void persistSettings(undefined, { enableHumanTeammates: value });
    };

    const updateTeamMembers = (
      next: Array<{ id: string; name: string }>,
      options?: { immediate?: boolean }
    ) => {
      setSettings((s) => (s ? { ...s, teamMembers: next } : null));
      if (options?.immediate !== false) {
        void persistSettings(undefined, { teamMembers: next });
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        persist: async () => {
          if (settings && !loading) await persistSettings();
        },
      }),
      [settings, loading, persistSettings]
    );

    const handleClose = useCallback(async () => {
      if (settings && !loading) {
        await persistSettings(true);
      }
      onClose();
    }, [settings, loading, persistSettings, onClose]);

    const settingsModalRef = useRef<HTMLDivElement>(null);
    useModalA11y({
      containerRef: settingsModalRef,
      onClose: () => void handleClose(),
      isOpen: !fullScreen,
    });

    const saveOnBlurRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
      return () => {
        if (saveOnBlurRef.current) {
          clearTimeout(saveOnBlurRef.current);
          saveOnBlurRef.current = null;
        }
      };
    }, []);
    const scheduleSaveOnBlur = useCallback(() => {
      if (saveOnBlurRef.current) clearTimeout(saveOnBlurRef.current);
      saveOnBlurRef.current = setTimeout(() => {
        saveOnBlurRef.current = null;
        void persistSettings();
      }, 100);
    }, [persistSettings]);

    const switchTab = useCallback(
      (tab: SettingsSubTab) => {
        if (settings) void persistSettings();
        setActiveTab(tab);
        if (fullScreen) {
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.set(TAB_PARAM, tab);
              return next;
            }
          );
        }
      },
      [settings, persistSettings, fullScreen, setSearchParams, setActiveTab]
    );

    const defaultAgent = { type: "cursor" as AgentType, model: null, cliCommand: null };

    const updateSimpleComplexityAgent = (
      updates: Partial<typeof simpleComplexityAgent>,
      options?: { immediate?: boolean }
    ) => {
      const next = { ...(simpleComplexityAgent ?? defaultAgent), ...updates };
      setSettings((s) => (s ? { ...s, simpleComplexityAgent: next } : null));
      if (options?.immediate !== false) {
        void persistSettings(undefined, { simpleComplexityAgent: next });
      }
    };

    const updateComplexComplexityAgent = (
      updates: Partial<typeof complexComplexityAgent>,
      options?: { immediate?: boolean }
    ) => {
      const next = { ...(complexComplexityAgent ?? defaultAgent), ...updates };
      setSettings((s) => (s ? { ...s, complexComplexityAgent: next } : null));
      if (options?.immediate !== false) {
        void persistSettings(undefined, { complexComplexityAgent: next });
      }
    };

    const updateDeployment = (
      updates: Partial<typeof deployment>,
      options?: { immediate?: boolean }
    ) => {
      const next = { ...deployment, ...updates };
      setSettings((s) => (s ? { ...s, deployment: next } : null));
      if (options?.immediate !== false) {
        void persistSettings(undefined, { deployment: next });
      }
    };

    const updateAiAutonomyLevel = (level: AiAutonomyLevel) => {
      setSettings((s) => (s ? { ...s, aiAutonomyLevel: level } : null));
      void persistSettings(undefined, { aiAutonomyLevel: level });
    };

    const updateWorkflowSettings = useCallback(
      (updater: (current: ProjectSettings) => ProjectSettings) => {
        setSettings((current) => (current ? updater(current) : current));
      },
      []
    );

    const renderProviderPrerequisite = (
      rowKey: "simple" | "complex",
      rowLabel: "Simple" | "Complex",
      provider: AgentType
    ) => {
      if (!envKeys) return null;

      if (provider === "claude" && !envKeys.anthropic) {
        return (
          <div
            className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
            data-testid={`${rowKey}-provider-prerequisite`}
          >
            <p className="text-sm text-theme-warning-text">
              <strong>Anthropic API key required</strong> —{" "}
              <Link
                to={`/projects/${project.id}/settings?level=global`}
                className="underline hover:opacity-80"
                data-testid={`configure-api-keys-link-${rowKey}`}
              >
                add in Global Settings
              </Link>
            </p>
          </div>
        );
      }

      if (provider === "cursor" && !envKeys.cursor) {
        return (
          <div
            className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
            data-testid={`${rowKey}-provider-prerequisite`}
          >
            <p className="text-sm text-theme-warning-text">
              <strong>Cursor API key required</strong> —{" "}
              <Link
                to={`/projects/${project.id}/settings?level=global`}
                className="underline hover:opacity-80"
                data-testid={`configure-api-keys-link-${rowKey}`}
              >
                add in Global Settings
              </Link>
            </p>
          </div>
        );
      }

      if (provider === "cursor" && envKeys.cursor && !envKeys.cursorCli) {
        return (
          <div
            className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
            data-testid={`${rowKey}-provider-prerequisite`}
          >
            <p className="text-sm text-theme-warning-text mb-2">
              <strong>Cursor CLI not found.</strong> The <code className="font-mono text-xs">agent</code> command is required for Cursor. Install it, then restart your terminal or Open Sprint.
            </p>
            <button
              type="button"
              className="btn btn-primary text-sm"
              disabled={cursorCliInstalling}
              onClick={async () => {
                setCursorCliInstallResult(null);
                setCursorCliInstalling(true);
                try {
                  const data = await api.env.installCursorCli();
                  setCursorCliInstallResult({
                    success: data.success,
                    message: data.message ?? (data.success ? "Install finished." : "Install failed."),
                  });
                } catch (err) {
                  setCursorCliInstallResult({
                    success: false,
                    message: err instanceof Error ? err.message : "Install request failed.",
                  });
                } finally {
                  setCursorCliInstalling(false);
                }
              }}
              data-testid="install-cursor-cli-btn"
            >
              {cursorCliInstalling ? "Installing…" : "Install Cursor CLI"}
            </button>
            {cursorCliInstallResult && (
              <p className={`text-sm mt-2 ${cursorCliInstallResult.success ? "text-theme-success-text" : "text-theme-error-text"}`}>
                {cursorCliInstallResult.message}
              </p>
            )}
          </div>
        );
      }

      if (provider === "openai" && !envKeys.openai) {
        return (
          <div
            className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
            data-testid={`${rowKey}-provider-prerequisite`}
          >
            <p className="text-sm text-theme-warning-text">
              <strong>OpenAI API key required</strong> —{" "}
              <Link
                to={`/projects/${project.id}/settings?level=global`}
                className="underline hover:opacity-80"
                data-testid={`configure-api-keys-link-${rowKey}`}
              >
                add in Global Settings
              </Link>
            </p>
          </div>
        );
      }

      if (provider === "google" && !envKeys.google) {
        return (
          <div
            className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
            data-testid={`${rowKey}-provider-prerequisite`}
          >
            <p className="text-sm text-theme-warning-text">
              <strong>Google API key required</strong> —{" "}
              <Link
                to={`/projects/${project.id}/settings?level=global`}
                className="underline hover:opacity-80"
                data-testid={`configure-api-keys-link-${rowKey}`}
              >
                add in Global Settings
              </Link>
            </p>
          </div>
        );
      }

      if (provider === "claude-cli" && !envKeys.claudeCli) {
        return (
          <div
            className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
            data-testid={`${rowKey}-provider-prerequisite`}
          >
            <p className="text-sm text-theme-warning-text">
              <strong>Claude CLI not found.</strong> Install it from{" "}
              <a
                href="https://docs.anthropic.com/en/docs/claude-code/getting-started"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-80"
              >
                docs.anthropic.com
              </a>{" "}
              and run <code className="font-mono text-xs">claude</code> to complete authentication.
            </p>
          </div>
        );
      }

      return null;
    };

    const wrapperClass = fullScreen
      ? "flex-1 min-h-0 flex flex-col overflow-hidden"
      : "fixed inset-0 z-50 flex items-center justify-center";
    const contentClass = fullScreen
      ? "relative flex-1 min-h-0 flex flex-col overflow-hidden"
      : "relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[85vh] overflow-hidden";

    return (
      <div className={wrapperClass}>
        {!fullScreen && (
          <button
            type="button"
            tabIndex={-1}
            className="absolute inset-0 w-full h-full bg-theme-overlay backdrop-blur-sm border-0 cursor-default"
            onClick={() => void handleClose()}
            aria-label="Close"
          />
        )}

        {fullScreen && !tabsControlledExternally && (
          <>
            <SettingsTopBar projectId={project.id} saveStatus={saveStatus} />
            <SettingsSubTabsBar activeTab={activeTab} onTabChange={switchTab} />
          </>
        )}
        <div
          ref={settingsModalRef}
          className={contentClass}
          data-testid="settings-modal"
          {...(!fullScreen && {
            role: "dialog",
            "aria-modal": true,
            "aria-label": "Project settings",
          })}
        >
          {!fullScreen && (
            <div
              className="flex-shrink-0 flex items-center justify-between px-5 py-4 border-b border-theme-border"
              data-testid="settings-modal-header"
            >
              <SettingsSubTabsBar activeTab={activeTab} onTabChange={switchTab} variant="inline" />
              <div className="flex items-center gap-3">
                <SaveIndicator status={saveStatus} data-testid="settings-save-indicator" />
                <CloseButton onClick={() => void handleClose()} ariaLabel="Close settings modal" />
              </div>
            </div>
          )}

          {/* Content */}
          <div
            className={`flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain pt-[15px] ${
              fullScreen
                ? `${SETTINGS_HELP_CONTAINER_CLASS} bg-theme-surface pb-4`
                : "px-5 py-4"
            }`}
            data-testid="settings-modal-content"
          >
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <>
                {activeTab === "basics" && (
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="project-name" className="block text-sm font-medium text-theme-text mb-1">
                        Project Name
                      </label>
                      <input
                        id="project-name"
                        type="text"
                        className="input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={scheduleSaveOnBlur}
                        placeholder="My Awesome App"
                      />
                    </div>
                    <div>
                      <label htmlFor="project-folder" className="block text-sm font-medium text-theme-text mb-1">
                        Project folder
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="project-folder"
                          type="text"
                          className="input font-mono text-sm flex-1"
                          value={repoPath}
                          onChange={(e) => setRepoPath(e.target.value)}
                          onBlur={scheduleSaveOnBlur}
                          placeholder="/Users/you/projects/my-app"
                        />
                        <button
                          type="button"
                          onClick={() => setShowFolderBrowser(true)}
                          className="btn-secondary text-sm px-3 whitespace-nowrap flex items-center gap-1.5"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                            />
                          </svg>
                          Browse
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-theme-muted">
                        Absolute path to the project repository
                      </p>
                    </div>
                  </div>
                )}

                {activeTab === "agents" && (
                  <div className="space-y-6">
                    <section
                      className="p-4 rounded-lg bg-theme-bg-elevated border border-theme-border"
                      data-testid="agent-config-how-this-works"
                    >
                      <p className="text-sm text-theme-muted">
                        How this works: Simple agents handle low/medium complexity tasks; Complex
                        agents handle high/very_high complexity tasks.
                      </p>
                    </section>
                    <div data-testid="task-complexity-section">
                      <h3 className="text-sm font-semibold text-theme-text mb-3">
                        Task Complexity
                      </h3>
                      <div className="space-y-4">
                        {/* Row 1: Simple */}
                        <div className="flex flex-wrap items-end gap-3">
                          <span className="w-16 text-sm font-medium text-theme-text shrink-0">
                            Simple
                          </span>
                          <div className="flex-1 min-w-[140px]">
                            <label htmlFor="simple-provider-select" className="block text-xs font-medium text-theme-muted mb-1">
                              Provider
                            </label>
                            <select
                              id="simple-provider-select"
                              className="input w-full"
                              value={simpleComplexityAgent.type}
                              onChange={(e) =>
                                updateSimpleComplexityAgent({
                                  type: e.target.value as AgentType,
                                })
                              }
                              onBlur={scheduleSaveOnBlur}
                            >
                              <option value="claude">Claude (API)</option>
                              <option value="claude-cli">Claude (CLI)</option>
                              <option value="cursor">Cursor</option>
                              <option value="openai">OpenAI</option>
                            <option value="google">Google (Gemini)</option>
                            <option value="lmstudio">LM Studio (local)</option>
                            <option value="custom">Custom CLI</option>
                          </select>
                        </div>
                        {simpleComplexityAgent.type === "lmstudio" && (
                          <div className="flex-1 min-w-[180px]">
                            <label htmlFor="simple-base-url" className="block text-xs font-medium text-theme-muted mb-1">
                              Base URL
                            </label>
                            <input
                              id="simple-base-url"
                              type="text"
                              className="input w-full font-mono text-sm"
                              placeholder={DEFAULT_LMSTUDIO_BASE_URL}
                              value={simpleComplexityAgent.baseUrl ?? ""}
                              onChange={(e) =>
                                updateSimpleComplexityAgent({
                                  baseUrl: e.target.value.trim() || undefined,
                                })
                              }
                              onBlur={scheduleSaveOnBlur}
                            />
                          </div>
                        )}
                        {simpleComplexityAgent.type !== "custom" ? (
                          <div className="flex-1 min-w-[140px]">
                            <label htmlFor="simple-agent-select" className="block text-xs font-medium text-theme-muted mb-1">
                              Agent
                            </label>
                            <ModelSelect
                              id="simple-agent-select"
                              provider={simpleComplexityAgent.type}
                              value={simpleComplexityAgent.model}
                              onChange={(id) => updateSimpleComplexityAgent({ model: id })}
                              onBlur={scheduleSaveOnBlur}
                              projectId={project.id}
                              refreshTrigger={modelRefreshTrigger}
                              baseUrl={
                                simpleComplexityAgent.type === "lmstudio"
                                  ? simpleComplexityAgent.baseUrl || DEFAULT_LMSTUDIO_BASE_URL
                                  : undefined
                              }
                            />
                          </div>
                        ) : (
                            <div className="flex-1 min-w-[200px]">
                              <label htmlFor="simple-cli-command" className="block text-xs font-medium text-theme-muted mb-1">
                                CLI command
                              </label>
                              <input
                                id="simple-cli-command"
                                type="text"
                                className="input w-full font-mono text-sm"
                                placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                                value={simpleComplexityAgent.cliCommand ?? ""}
                                onChange={(e) =>
                                  updateSimpleComplexityAgent(
                                    { cliCommand: e.target.value || null },
                                    { immediate: false }
                                  )
                                }
                                onBlur={scheduleSaveOnBlur}
                              />
                            </div>
                          )}
                        </div>
                        {renderProviderPrerequisite(
                          "simple",
                          "Simple",
                          simpleComplexityAgent.type
                        )}
                        {/* Row 2: Complex */}
                        <div className="flex flex-wrap items-end gap-3">
                          <span className="w-16 text-sm font-medium text-theme-text shrink-0">
                            Complex
                          </span>
                          <div className="flex-1 min-w-[140px]">
                            <label htmlFor="complex-provider-select" className="block text-xs font-medium text-theme-muted mb-1">
                              Provider
                            </label>
                            <select
                              id="complex-provider-select"
                              className="input w-full"
                              value={complexComplexityAgent.type}
                              onChange={(e) =>
                                updateComplexComplexityAgent({ type: e.target.value as AgentType })
                              }
                              onBlur={scheduleSaveOnBlur}
                            >
                              <option value="claude">Claude (API)</option>
                              <option value="claude-cli">Claude (CLI)</option>
                              <option value="cursor">Cursor</option>
                              <option value="openai">OpenAI</option>
                            <option value="google">Google (Gemini)</option>
                            <option value="lmstudio">LM Studio (local)</option>
                            <option value="custom">Custom CLI</option>
                          </select>
                        </div>
                        {complexComplexityAgent.type === "lmstudio" && (
                          <div className="flex-1 min-w-[180px]">
                            <label htmlFor="complex-base-url" className="block text-xs font-medium text-theme-muted mb-1">
                              Base URL
                            </label>
                            <input
                              id="complex-base-url"
                              type="text"
                              className="input w-full font-mono text-sm"
                              placeholder={DEFAULT_LMSTUDIO_BASE_URL}
                              value={complexComplexityAgent.baseUrl ?? ""}
                              onChange={(e) =>
                                updateComplexComplexityAgent({
                                  baseUrl: e.target.value.trim() || undefined,
                                })
                              }
                              onBlur={scheduleSaveOnBlur}
                            />
                          </div>
                        )}
                        {complexComplexityAgent.type !== "custom" ? (
                          <div className="flex-1 min-w-[140px]">
                            <label htmlFor="complex-agent-select" className="block text-xs font-medium text-theme-muted mb-1">
                              Agent
                            </label>
                            <ModelSelect
                              id="complex-agent-select"
                              provider={complexComplexityAgent.type}
                              value={complexComplexityAgent.model}
                              onChange={(id) => updateComplexComplexityAgent({ model: id })}
                              onBlur={scheduleSaveOnBlur}
                              projectId={project.id}
                              refreshTrigger={modelRefreshTrigger}
                              baseUrl={
                                complexComplexityAgent.type === "lmstudio"
                                  ? complexComplexityAgent.baseUrl || DEFAULT_LMSTUDIO_BASE_URL
                                  : undefined
                              }
                            />
                          </div>
                        ) : (
                          <div className="flex-1 min-w-[200px]">
                            <label htmlFor="complex-cli-command" className="block text-xs font-medium text-theme-muted mb-1">
                              CLI command
                            </label>
                            <input
                              id="complex-cli-command"
                              type="text"
                              className="input w-full font-mono text-sm"
                              placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                              value={complexComplexityAgent.cliCommand ?? ""}
                                onChange={(e) =>
                                  updateComplexComplexityAgent(
                                    { cliCommand: e.target.value || null },
                                    { immediate: false }
                                  )
                                }
                                onBlur={scheduleSaveOnBlur}
                              />
                            </div>
                          )}
                        </div>
                        {renderProviderPrerequisite(
                          "complex",
                          "Complex",
                          complexComplexityAgent.type
                        )}
                      </div>
                    </div>
                    <div
                      className="rounded-lg border border-theme-border bg-theme-bg-elevated"
                      data-testid="agents-advanced-section"
                    >
                      <button
                        type="button"
                        onClick={() => setAdvancedExpanded((v) => !v)}
                        className="w-full flex items-center justify-between cursor-pointer px-4 py-3 text-sm font-semibold text-theme-text text-left hover:bg-theme-border-subtle/50 transition-colors rounded-none first:rounded-t-lg"
                        aria-expanded={advancedExpanded}
                        aria-label={advancedExpanded ? "Collapse Advanced" : "Expand Advanced"}
                      >
                        Advanced
                        <span className="text-theme-muted text-xs">{advancedExpanded ? "▼" : "▶"}</span>
                      </button>
                      {advancedExpanded && (
                        <div className="px-4 pb-4 pt-1 border-t border-theme-border">
                          <Suspense fallback={<AgentsSectionFallback />}>
                            <AgentsMdSection projectId={project.id} />
                          </Suspense>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "workflow" && settings && (
                  <div data-testid="workflow-tab-content">
                    <WorkflowSettingsContent
                      settings={settings}
                      projectId={project.id}
                      persistSettings={persistSettings}
                      scheduleSaveOnBlur={scheduleSaveOnBlur}
                      lastReviewAnglesRef={lastReviewAnglesRef}
                      onSettingsChange={updateWorkflowSettings}
                    />
                  </div>
                )}

                {activeTab === "deployment" && (
                  <div className="space-y-4">
                    <div className="space-y-3 p-3 rounded-lg bg-theme-bg-elevated border border-theme-border">
                      <h3 className="text-sm font-semibold text-theme-text">
                        Auto-deploy per environment
                      </h3>
                      <p className="text-xs text-theme-muted">
                        Choose when to automatically deploy to each target.
                      </p>
                      {getDeploymentTargetsForUi(deployment).map((target) => (
                        <div key={target.name} className="flex items-center justify-between gap-3">
                          <label htmlFor={`auto-deploy-trigger-${target.name}`} className="text-sm text-theme-text shrink-0">{target.name}:</label>
                          <select
                            id={`auto-deploy-trigger-${target.name}`}
                            value={target.autoDeployTrigger ?? "none"}
                            onChange={(e) => {
                              const trigger = e.target.value as AutoDeployTrigger;
                              const uiTargets = getDeploymentTargetsForUi(deployment);
                              const current = deployment.targets ?? [];
                              const updated = uiTargets.map((t) => {
                                const existing = current.find((c) => c.name === t.name);
                                const base = existing ?? { name: t.name };
                                return t.name === target.name
                                  ? { ...base, autoDeployTrigger: trigger }
                                  : {
                                      ...base,
                                      autoDeployTrigger:
                                        base.autoDeployTrigger ?? t.autoDeployTrigger ?? "none",
                                    };
                              });
                              updateDeployment({ targets: updated });
                            }}
                            className="rounded border border-theme-border bg-theme-surface px-2 py-1 text-sm"
                            data-testid={`auto-deploy-trigger-${target.name}`}
                          >
                            {AUTO_DEPLOY_TRIGGER_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                      <label htmlFor="auto-resolve-feedback-toggle" className="flex items-center justify-between gap-3 cursor-pointer">
                        <span className="text-sm text-theme-text">
                          Auto-resolve feedback when tasks done
                        </span>
                        <input
                          id="auto-resolve-feedback-toggle"
                          type="checkbox"
                          checked={deployment.autoResolveFeedbackOnTaskCompletion ?? false}
                          onChange={(e) =>
                            updateDeployment({
                              autoResolveFeedbackOnTaskCompletion: e.target.checked,
                            })
                          }
                          className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                          data-testid="auto-resolve-feedback-toggle"
                        />
                      </label>
                      <p className="text-xs text-theme-muted ml-1">
                        When all tasks created from feedback reach Done, mark the feedback as
                        resolved.
                      </p>
                    </div>
                    <div>
                      <label htmlFor="deployment-mode-expo" className="block text-sm font-medium text-theme-text mb-3">
                        Delivery Mode
                      </label>
                      <div className="space-y-3">
                        <label htmlFor="deployment-mode-expo" className="flex items-start gap-3 p-3 rounded-lg border border-theme-border hover:border-theme-info-border cursor-pointer transition-colors" aria-label="Expo.dev - Automatic delivery for React Native and web projects">
                          <input
                            id="deployment-mode-expo"
                            type="radio"
                            name="deployment"
                            value="expo"
                            checked={deployment.mode === "expo"}
                            onChange={() => {
                              updateDeployment({
                                mode: "expo",
                                expoConfig: {
                                  channel: deployment.expoConfig?.channel ?? "preview",
                                  projectId:
                                    deployment.expoConfig?.projectId ??
                                    deployment.easProjectId ??
                                    undefined,
                                },
                              });
                            }}
                            className="mt-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                          />
                          <div>
                            <p className="text-sm font-medium text-theme-text">Expo.dev</p>
                            <p className="text-xs text-theme-muted">
                              Automatic delivery for React Native and web projects
                            </p>
                          </div>
                        </label>
                        <label htmlFor="deployment-mode-custom" className="flex items-start gap-3 p-3 rounded-lg border border-theme-border hover:border-theme-info-border cursor-pointer transition-colors" aria-label="Custom Pipeline - Command or webhook triggered after Execute completion">
                          <input
                            id="deployment-mode-custom"
                            type="radio"
                            name="deployment"
                            value="custom"
                            checked={deployment.mode === "custom"}
                            onChange={() => {
                              updateDeployment({ mode: "custom" });
                            }}
                            className="mt-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                          />
                          <div>
                            <p className="text-sm font-medium text-theme-text">Custom Pipeline</p>
                            <p className="text-xs text-theme-muted">
                              Command or webhook triggered after Execute completion
                            </p>
                          </div>
                        </label>
                      </div>
                    </div>
                    {deployment.mode === "custom" && (
                      <div className="space-y-3 pt-2 border-t border-theme-border">
                        <div>
                          <h4 className="text-sm font-medium text-theme-text mb-2">
                            Delivery targets
                          </h4>
                          <p className="text-xs text-theme-muted mb-2">
                            Define staging/production targets with per-target command or webhook.
                          </p>
                          {(deployment.targets ?? []).map((t, i) => (
                            <div
                              key={i}
                              className="mb-3 p-3 rounded-lg border border-theme-border bg-theme-surface"
                            >
                              <div className="flex justify-between items-center mb-2">
                                <input
                                  type="text"
                                  className="input flex-1 mr-2 font-mono text-sm"
                                  placeholder="Target name (e.g. staging, production)"
                                  value={t.name}
                                  onChange={(e) => {
                                    const next = [...(deployment.targets ?? [])];
                                    next[i] = { ...t, name: e.target.value };
                                    updateDeployment({ targets: next }, { immediate: false });
                                  }}
                                  onBlur={scheduleSaveOnBlur}
                                />
                                <label htmlFor={`deployment-target-default-${i}`} className="flex items-center gap-1 text-xs">
                                  <input
                                    id={`deployment-target-default-${i}`}
                                    type="checkbox"
                                    checked={t.isDefault ?? false}
                                    className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                                    onChange={(e) => {
                                      const next = (deployment.targets ?? []).map((x, j) =>
                                        j === i
                                          ? { ...x, isDefault: e.target.checked }
                                          : { ...x, isDefault: false }
                                      );
                                      updateDeployment({ targets: next });
                                    }}
                                  />
                                  default
                                </label>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = (deployment.targets ?? []).filter(
                                      (_, j) => j !== i
                                    );
                                    updateDeployment({ targets: next.length ? next : undefined });
                                  }}
                                  className="text-theme-error-text hover:opacity-80 text-xs ml-1"
                                >
                                  Remove
                                </button>
                              </div>
                              <input
                                type="text"
                                className="input w-full font-mono text-xs mb-1"
                                placeholder="Command (e.g. ./deploy-staging.sh)"
                                value={t.command ?? ""}
                                onChange={(e) => {
                                  const next = [...(deployment.targets ?? [])];
                                  next[i] = { ...t, command: e.target.value || undefined };
                                  updateDeployment({ targets: next }, { immediate: false });
                                }}
                                onBlur={scheduleSaveOnBlur}
                              />
                              <input
                                type="url"
                                className="input w-full font-mono text-xs mb-1"
                                placeholder="Webhook URL (alternative to command)"
                                value={t.webhookUrl ?? ""}
                                onChange={(e) => {
                                  const next = [...(deployment.targets ?? [])];
                                  next[i] = { ...t, webhookUrl: e.target.value || undefined };
                                  updateDeployment({ targets: next }, { immediate: false });
                                }}
                                onBlur={scheduleSaveOnBlur}
                              />
                              <input
                                type="text"
                                className="input w-full font-mono text-xs"
                                placeholder="Rollback command (e.g. ./rollback.sh)"
                                value={t.rollbackCommand ?? ""}
                                onChange={(e) => {
                                  const next = [...(deployment.targets ?? [])];
                                  next[i] = { ...t, rollbackCommand: e.target.value || undefined };
                                  updateDeployment({ targets: next }, { immediate: false });
                                }}
                                onBlur={scheduleSaveOnBlur}
                              />
                              <div className="mt-3 pt-3 border-t border-theme-border">
                                <h5 className="text-xs font-medium text-theme-text mb-2">
                                  Environment variables
                                </h5>
                                <p className="text-xs text-theme-muted mb-2">
                                  Key-value pairs for this target (passed to command/webhook).
                                </p>
                                {Object.entries(t.envVars ?? {}).map(([k, v], j) => (
                                  <div key={j} className="flex gap-2 mb-2">
                                    <input
                                      type="text"
                                      className="input flex-1 font-mono text-xs"
                                      placeholder="KEY"
                                      value={k}
                                      onChange={(e) => {
                                        const next = [...(deployment.targets ?? [])];
                                        const ev = { ...(next[i].envVars ?? {}) };
                                        delete ev[k];
                                        if (e.target.value) ev[e.target.value] = v;
                                        next[i] = {
                                          ...next[i],
                                          envVars: Object.keys(ev).length ? ev : undefined,
                                        };
                                        updateDeployment({ targets: next }, { immediate: false });
                                      }}
                                    />
                                    <input
                                      type="text"
                                      className="input flex-1 font-mono text-xs"
                                      placeholder="value"
                                      value={v}
                                      onChange={(e) => {
                                        const next = [...(deployment.targets ?? [])];
                                        next[i] = {
                                          ...next[i],
                                          envVars: {
                                            ...(next[i].envVars ?? {}),
                                            [k]: e.target.value,
                                          },
                                        };
                                        updateDeployment({ targets: next }, { immediate: false });
                                      }}
                                    />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const next = [...(deployment.targets ?? [])];
                                        const ev = { ...(next[i].envVars ?? {}) };
                                        delete ev[k];
                                        next[i] = {
                                          ...next[i],
                                          envVars: Object.keys(ev).length ? ev : undefined,
                                        };
                                        updateDeployment({ targets: next });
                                      }}
                                      className="text-theme-error-text hover:opacity-80 text-xs"
                                    >
                                      Remove
                                    </button>
                                  </div>
                                ))}
                                {(() => {
                                  const tk = `custom-${i}`;
                                  const row = newEnvRow[tk] ?? { key: "", value: "" };
                                  const commitNewRow = (keyVal: string, valueVal: string) => {
                                    const k = keyVal.trim();
                                    if (!k || (t.envVars ?? {})[k] !== undefined) return;
                                    const next = [...(deployment.targets ?? [])];
                                    next[i] = {
                                      ...next[i],
                                      envVars: { ...(next[i].envVars ?? {}), [k]: valueVal },
                                    };
                                    updateDeployment({ targets: next });
                                    setNewEnvRow((prev) => {
                                      const u = { ...prev };
                                      delete u[tk];
                                      return u;
                                    });
                                  };
                                  return (
                                    <div className="flex gap-2 mb-2">
                                      <input
                                        type="text"
                                        className="input flex-1 font-mono text-xs"
                                        placeholder="KEY"
                                        value={row.key}
                                        onChange={(e) =>
                                          setNewEnvRow((prev) => ({
                                            ...prev,
                                            [tk]: { ...row, key: e.target.value },
                                          }))
                                        }
                                        onBlur={(e) => {
                                          const k = e.target.value.trim();
                                          if (k) commitNewRow(k, row.value);
                                        }}
                                        data-testid="env-var-name-input"
                                      />
                                      <input
                                        type="text"
                                        className="input flex-1 font-mono text-xs"
                                        placeholder="value"
                                        value={row.value}
                                        onChange={(e) =>
                                          setNewEnvRow((prev) => ({
                                            ...prev,
                                            [tk]: { ...row, value: e.target.value },
                                          }))
                                        }
                                        onBlur={(e) => {
                                          const k = row.key.trim();
                                          if (k) commitNewRow(k, e.target.value);
                                        }}
                                        data-testid="env-var-value-input"
                                      />
                                    </div>
                                  );
                                })()}
                              </div>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              const next = [
                                ...(deployment.targets ?? []),
                                { name: "", isDefault: (deployment.targets ?? []).length === 0 },
                              ];
                              updateDeployment({ targets: next });
                            }}
                            className="btn-secondary text-sm"
                          >
                            + Add target
                          </button>
                        </div>
                      </div>
                    )}
                    {deployment.mode === "expo" && (
                      <div className="space-y-3 pt-2 border-t border-theme-border">
                        <div>
                          <label
                            htmlFor="eas-project-id"
                            className="block text-sm font-medium text-theme-text mb-1"
                          >
                            EAS Project ID
                          </label>
                          <input
                            id="eas-project-id"
                            type="text"
                            className="input w-full font-mono text-sm"
                            placeholder="e.g. abc123-def456-ghi789"
                            value={
                              deployment.easProjectId ??
                              deployment.expoConfig?.projectId ??
                              ""
                            }
                            onChange={(e) => {
                              const value = e.target.value.trim() || undefined;
                              updateDeployment({
                                expoConfig: {
                                  channel: deployment.expoConfig?.channel ?? "preview",
                                  projectId: value,
                                },
                              });
                            }}
                            onBlur={scheduleSaveOnBlur}
                            data-testid="eas-project-id-input"
                          />
                          <p className="mt-1 text-xs text-theme-muted">
                            Link to an existing Expo project. Leave blank to create one on first
                            deploy.
                          </p>
                        </div>
                        <h4 className="text-sm font-medium text-theme-text">
                          Environment variables per target
                        </h4>
                        <p className="text-xs text-theme-muted">
                          Key-value pairs passed to deploy for each target.
                        </p>
                        {getDeploymentTargetsForUi(deployment).map((target) => {
                          const targetEnvVars = target.envVars ?? {};
                          const updateTargetEnvVars = (newEnvVars: Record<string, string>) => {
                            const uiTargets = getDeploymentTargetsForUi(deployment);
                            const current = deployment.targets ?? [];
                            const next = uiTargets.map((t) => {
                              const existing = current.find((c) => c.name === t.name);
                              const base = existing ?? { name: t.name };
                              return t.name === target.name
                                ? { ...base, envVars: newEnvVars }
                                : base;
                            });
                            updateDeployment({ targets: next });
                          };
                          return (
                            <div
                              key={target.name}
                              className="p-3 rounded-lg border border-theme-border bg-theme-surface"
                            >
                              <h5 className="text-xs font-medium text-theme-text mb-2">
                                {target.name}
                              </h5>
                              {Object.entries(targetEnvVars).map(([k, v], j) => (
                                <div key={j} className="flex gap-2 mb-2">
                                  <input
                                    type="text"
                                    className="input flex-1 font-mono text-xs"
                                    placeholder="KEY"
                                    value={k}
                                    onChange={(e) => {
                                      const next = { ...targetEnvVars };
                                      delete next[k];
                                      if (e.target.value) next[e.target.value] = v;
                                      updateTargetEnvVars(next);
                                    }}
                                  />
                                  <input
                                    type="text"
                                    className="input flex-1 font-mono text-xs"
                                    placeholder="value"
                                    value={v}
                                    onChange={(e) => {
                                      updateTargetEnvVars({
                                        ...targetEnvVars,
                                        [k]: e.target.value,
                                      });
                                    }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const next = { ...targetEnvVars };
                                      delete next[k];
                                      updateTargetEnvVars(next);
                                    }}
                                    className="text-theme-error-text hover:opacity-80 text-xs"
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                              {(() => {
                                const tk = `expo-${target.name}`;
                                const row = newEnvRow[tk] ?? { key: "", value: "" };
                                const commitNewRow = (keyVal: string, valueVal: string) => {
                                  const k = keyVal.trim();
                                  if (!k || targetEnvVars[k] !== undefined) return;
                                  updateTargetEnvVars({ ...targetEnvVars, [k]: valueVal });
                                  setNewEnvRow((prev) => {
                                    const u = { ...prev };
                                    delete u[tk];
                                    return u;
                                  });
                                };
                                return (
                                  <div className="flex gap-2 mb-2">
                                    <input
                                      type="text"
                                      className="input flex-1 font-mono text-xs"
                                      placeholder="KEY"
                                      value={row.key}
                                      onChange={(e) =>
                                        setNewEnvRow((prev) => ({
                                          ...prev,
                                          [tk]: { ...row, key: e.target.value },
                                        }))
                                      }
                                      onBlur={(e) => {
                                        const k = e.target.value.trim();
                                        if (k) commitNewRow(k, row.value);
                                      }}
                                      data-testid="env-var-name-input"
                                    />
                                    <input
                                      type="text"
                                      className="input flex-1 font-mono text-xs"
                                      placeholder="value"
                                      value={row.value}
                                      onChange={(e) =>
                                        setNewEnvRow((prev) => ({
                                          ...prev,
                                          [tk]: { ...row, value: e.target.value },
                                        }))
                                      }
                                      onBlur={(e) => {
                                        const k = row.key.trim();
                                        if (k) commitNewRow(k, e.target.value);
                                      }}
                                      data-testid="env-var-value-input"
                                    />
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "hil" && (
                  <div className="space-y-4">
                    <p className="text-sm text-theme-muted mb-4">
                      Configure when Open Sprint should pause for your input vs. proceed
                      autonomously.
                    </p>
                    <div className="space-y-4">
                      <h3 className="text-sm font-semibold text-theme-text">AI Autonomy</h3>
                      <div className="space-y-3">
                        <input
                          type="range"
                          min={0}
                          max={AI_AUTONOMY_LEVELS.length - 1}
                          step={1}
                          value={(() => {
                            const idx = AI_AUTONOMY_LEVELS.findIndex(
                              (l) => l.value === aiAutonomyLevel
                            );
                            return idx >= 0 ? idx : AI_AUTONOMY_LEVELS.length - 1;
                          })()}
                          onChange={(e) => {
                            const i = Number(e.target.value);
                            const opt = AI_AUTONOMY_LEVELS[i];
                            if (opt) updateAiAutonomyLevel(opt.value);
                          }}
                          onBlur={scheduleSaveOnBlur}
                          className="w-full accent-brand-600"
                          aria-label="AI Autonomy level"
                          data-testid="ai-autonomy-slider"
                        />
                        <div className="flex justify-between text-xs text-theme-muted">
                          {AI_AUTONOMY_LEVELS.map((opt) => (
                            <span
                              key={opt.value}
                              className={
                                opt.value === aiAutonomyLevel ? "font-medium text-theme-text" : ""
                              }
                            >
                              {opt.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === "team" && (
                  <div className="space-y-4" data-testid="team-tab-content">
                    <label htmlFor="enable-human-teammates-checkbox" className="flex items-center gap-2 cursor-pointer">
                      <input
                        id="enable-human-teammates-checkbox"
                        type="checkbox"
                        checked={enableHumanTeammates}
                        onChange={(e) => setEnableHumanTeammates(e.target.checked)}
                        className="rounded border-theme-border focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        data-testid="enable-human-teammates-checkbox"
                      />
                      <span className="text-sm font-medium text-theme-text">
                        Enable human teammates
                      </span>
                    </label>
                    {enableHumanTeammates && (
                      <>
                        <h3 className="text-sm font-semibold text-theme-text">Team Members</h3>
                        <p className="text-xs text-theme-muted mb-3">
                          Add teammates who can be assigned to tasks. Each member has a display name.
                        </p>
                        <div className="space-y-3">
                          {teamMembers.map((member, i) => (
                        <div
                          key={member.id}
                          className="flex flex-wrap items-center gap-2 p-3 rounded-lg border border-theme-border bg-theme-surface"
                          data-testid="team-member-row"
                        >
                          <input
                            type="text"
                            className="input flex-1 min-w-[100px] text-sm"
                            placeholder="Name"
                            value={member.name}
                            onChange={(e) => {
                              const next = [...teamMembers];
                              next[i] = { ...member, name: e.target.value };
                              updateTeamMembers(next, { immediate: false });
                            }}
                            onBlur={scheduleSaveOnBlur}
                            data-testid="team-member-name-input"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const next = teamMembers.filter((_, j) => j !== i);
                              updateTeamMembers(next);
                            }}
                            className="text-theme-error-text hover:opacity-80 text-sm px-2"
                            data-testid="team-member-remove"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                        <button
                          type="button"
                          onClick={() => {
                            const next = [
                              ...teamMembers,
                              { id: crypto.randomUUID(), name: "" },
                            ];
                            updateTeamMembers(next);
                          }}
                          className="btn-secondary text-sm"
                          data-testid="team-member-add"
                        >
                          + Add member
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mx-5 mb-3 p-3 bg-theme-error-bg border border-theme-error-border rounded-lg">
              <p className="text-sm text-theme-error-text">{error}</p>
            </div>
          )}
        </div>

        {showFolderBrowser && (
          <FolderBrowser
            initialPath={repoPath || undefined}
            onSelect={(path) => {
              setRepoPath(path);
              setShowFolderBrowser(false);
            }}
            onCancel={() => setShowFolderBrowser(false)}
          />
        )}
      </div>
    );
  }
);
