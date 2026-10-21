import {
  getTestCommandForFramework,
  parseSettings,
  omitInheritedAgentTiersForStore,
} from "@opensprint/shared";
import type { ProjectSettings } from "@opensprint/shared";
import {
  getRawSettingsWithMetaFromStore,
  transformRawSettingsInStore,
  updateSettingsInStore,
} from "../settings-store.service.js";
import { getGlobalSettings } from "../global-settings.service.js";
import { detectTestFramework } from "../test-framework.service.js";
import {
  buildDefaultSettings,
  clampValidationTimeoutMs,
  DEFAULT_VALIDATION_TIMEOUT_MS,
  normalizeValidationSample,
  percentile,
  toCanonicalSettings,
  VALIDATION_TIMING_SAMPLE_LIMIT,
  VALIDATION_TIMEOUT_BUFFER_MS,
  VALIDATION_TIMEOUT_MULTIPLIER,
} from "./project-settings-helpers.js";
import { projectSettingsFromRaw } from "./project-settings-from-raw.js";
import { mergeRepoToolchainProfileOverride } from "./repo-toolchain-override.js";

export async function loadProjectSettingsFromStore(
  projectId: string,
  repoPath: string
): Promise<ProjectSettings> {
  const defaults = buildDefaultSettings();
  const stored = await getRawSettingsWithMetaFromStore(projectId);
  const gs = await getGlobalSettings();
  if (!stored.exists) {
    const detected = await detectTestFramework(repoPath);
    const canonicalDefaults = toCanonicalSettings(defaults) as unknown as Record<string, unknown>;
    delete canonicalDefaults.simpleComplexityAgent;
    delete canonicalDefaults.complexComplexityAgent;
    delete canonicalDefaults.lowComplexityAgent;
    delete canonicalDefaults.highComplexityAgent;
    canonicalDefaults.testFramework = detected?.framework ?? null;
    canonicalDefaults.testCommand =
      detected?.testCommand ?? (getTestCommandForFramework(null) || null);
    const initialized = await transformRawSettingsInStore(projectId, (_current, { exists }) =>
      exists ? undefined : canonicalDefaults
    );
    const initial = projectSettingsFromRaw(initialized.settings, gs);
    return {
      ...(await mergeRepoToolchainProfileOverride(repoPath, initial)),
      revision: initialized.revision,
    };
  }
  const loaded = projectSettingsFromRaw(stored.settings, gs);
  return {
    ...(await mergeRepoToolchainProfileOverride(repoPath, loaded)),
    revision: stored.revision,
  };
}

export async function recordValidationDurationInStore(
  projectId: string,
  scope: "scoped" | "full",
  durationMs: number
): Promise<void> {
  const sample = normalizeValidationSample(durationMs);
  if (sample === null) return;

  const defaults = buildDefaultSettings();
  await updateSettingsInStore(projectId, defaults, (current) => {
    const rawSnapshot = current as unknown as Record<string, unknown>;
    const normalized = toCanonicalSettings(parseSettings(current));
    const existing = normalized.validationTimingProfile ?? {};
    const scopedSamples =
      scope === "scoped"
        ? [...(existing.scoped ?? []), sample].slice(-VALIDATION_TIMING_SAMPLE_LIMIT)
        : (existing.scoped ?? []);
    const fullSamples =
      scope === "full"
        ? [...(existing.full ?? []), sample].slice(-VALIDATION_TIMING_SAMPLE_LIMIT)
        : (existing.full ?? []);

    const merged = toCanonicalSettings({
      ...normalized,
      validationTimingProfile: {
        ...(scopedSamples.length > 0 && { scoped: scopedSamples }),
        ...(fullSamples.length > 0 && { full: fullSamples }),
        updatedAt: new Date().toISOString(),
      },
    });
    return omitInheritedAgentTiersForStore(
      merged as unknown as Record<string, unknown>,
      rawSnapshot
    ) as unknown as ProjectSettings;
  });
}

export function computeValidationTimeoutMs(
  settings: ProjectSettings,
  scope: "scoped" | "full"
): number {
  if (typeof settings.validationTimeoutMsOverride === "number") {
    return clampValidationTimeoutMs(settings.validationTimeoutMsOverride);
  }

  const profile = settings.validationTimingProfile;
  const scoped = (profile?.scoped ?? []).filter((v): v is number => typeof v === "number");
  const full = (profile?.full ?? []).filter((v): v is number => typeof v === "number");
  const samples =
    scope === "scoped" ? (scoped.length > 0 ? scoped : full) : full.length > 0 ? full : scoped;

  if (samples.length === 0) {
    return DEFAULT_VALIDATION_TIMEOUT_MS;
  }

  const p95 = percentile(samples, 0.95);
  const adaptive = Math.round(p95 * VALIDATION_TIMEOUT_MULTIPLIER + VALIDATION_TIMEOUT_BUFFER_MS);
  return clampValidationTimeoutMs(adaptive);
}
