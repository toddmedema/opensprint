import fs from 'fs/promises';
import path from 'path';

/** Default EAS Build config for Expo projects (PRD §6.4) */
export const DEFAULT_EAS_JSON = {
  cli: { version: '>= 5.0.0' },
  build: {
    development: {
      developmentClient: true,
      distribution: 'internal' as const,
      ios: { simulator: true },
    },
    preview: {
      distribution: 'internal' as const,
      channel: 'preview',
      ios: { simulator: true },
      android: { buildType: 'apk' as const },
    },
    production: {
      channel: 'production',
    },
  },
  submit: {
    production: {},
  },
};

/**
 * Ensure eas.json exists for EAS Build and OTA updates (PRD §6.4).
 * Creates default config if missing.
 */
export async function ensureEasConfig(repoPath: string): Promise<void> {
  const easPath = path.join(repoPath, 'eas.json');
  try {
    await fs.access(easPath);
    // Already exists
  } catch {
    await fs.writeFile(
      easPath,
      JSON.stringify(DEFAULT_EAS_JSON, null, 2),
      'utf-8',
    );
  }
}
