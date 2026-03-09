# Electron GitHub Release Builds — Actionable Implementation Plan

This plan describes how to attach cross-platform Electron builds (DMG, exe, AppImage) to GitHub Releases. Version is set from the tag in both root and `packages/electron/package.json`. Mac: DMG only (no .zip).

Implement the steps below in order. Each step is self-contained so another agent can execute them sequentially.

---

## Step 1: Version-from-tag script

- **Goal**: Set `version` in both root and electron package.json from the git tag so the built installers show the correct version.
- **Add file**: `scripts/set-version-from-tag.js`
- **Behavior**:
  - Read version from `process.env.TAG_VERSION` (e.g. `v1.2.3`). If missing or empty, exit with code 1 and a short message.
  - Strip a leading `v` to get a semver string (e.g. `1.2.3`).
  - Update `version` in repo root `package.json` to that string (read JSON, set `version`, write back with 2-space indent).
  - Update `version` in `packages/electron/package.json` to the same string.
  - Use only Node built-ins (`fs`, `path`); script must run on all three OS runners without extra deps.
- **Invocation**: The workflow will set `TAG_VERSION` to `${{ github.ref_name }}` and run `node scripts/set-version-from-tag.js` before `npm run build:desktop`.

---

## Step 2: Create the workflow file and trigger

- **Add file**: `.github/workflows/release-desktop.yml`
- **Trigger**: `on: push: tags: ['v*']`
- **Permissions**: `contents: write` (so the job can create/update releases and upload assets).
- **Conventions**: Use Node 20 (match repo `engines`). Use `npm ci` for installs. Use `actions/setup-node` with `cache: 'npm'` for faster runs.

---

## Step 3: create-release job

- **Job id**: `create-release`
- **Runner**: `ubuntu-latest`
- **Steps**:
  1. Checkout the repo (default checkout).
  2. Run `softprops/action-gh-release` with:
     - `tag_name: ${{ github.ref_name }}`
     - `body`: short static body, e.g. "Desktop release. Download the DMG (macOS), Windows installer (exe), or AppImage (Linux) below."
     - Do not pass `files` (release is created with no assets).
- **Purpose**: Create the release once so the three build jobs can upload to it without races.

---

## Step 4: build-mac job

- **Job id**: `build-mac`
- **Runner**: `macos-latest`
- **Needs**: `create-release`
- **Steps**:
  1. Checkout.
  2. Setup Node 20 with npm cache.
  3. Set env `TAG_VERSION: ${{ github.ref_name }}`.
  4. Run `node scripts/set-version-from-tag.js`.
  5. Run `npm ci`.
  6. Run `npm run build:desktop`.
  7. Run `softprops/action-gh-release` with the same `tag_name: ${{ github.ref_name }}` and `files: packages/electron/dist/*.dmg` only (no .zip).
- **Artifacts**: Only `*.dmg` from `packages/electron/dist/`.

---

## Step 5: build-windows job

- **Job id**: `build-windows`
- **Runner**: `windows-latest`
- **Needs**: `create-release`
- **Steps**: Same as build-mac (checkout, Node 20, `TAG_VERSION`, `set-version-from-tag.js`, `npm ci`, `npm run build:desktop`), then upload with `files: packages/electron/dist/*.exe` (NSIS installer only; no blockmap required for this plan).

---

## Step 6: build-linux job

- **Job id**: `build-linux`
- **Runner**: `ubuntu-latest`
- **Needs**: `create-release`
- **Steps**: Same as build-mac (checkout, Node 20, `TAG_VERSION`, `set-version-from-tag.js`, `npm ci`, `npm run build:desktop`), then upload with `files: packages/electron/dist/*.AppImage`.

---

## Step 7: README note

- **File**: `README.md`
- **Add**: A subsection titled **Publishing desktop releases** (under the existing "Desktop build" / "Building the desktop app" area, or a short "Releases" section).
- **Content**: State that pushing a version tag (e.g. `v1.0.0`) triggers GitHub Actions to build the Electron app for macOS (DMG), Windows (installer .exe), and Linux (AppImage), and to attach those files to the GitHub Release for that tag. Add one line that the workflow sets the app version from the tag.

---

## Artifact paths (reference)

- **macOS**: `packages/electron/dist/*.dmg` only.
- **Windows**: `packages/electron/dist/*.exe` (NSIS).
- **Linux**: `packages/electron/dist/*.AppImage`.

Globs work regardless of version (e.g. `Open Sprint-1.0.0.dmg`). No hardcoded version in the workflow.

---

## Verification

- Pushing a tag like `v0.2.0` creates a GitHub Release and attaches exactly three assets: one .dmg, one .exe, one .AppImage.
- Root and `packages/electron/package.json` both show the version matching the tag (e.g. `0.2.0`) in the built artifacts.
- README clearly explains how to publish desktop releases via tag push.
