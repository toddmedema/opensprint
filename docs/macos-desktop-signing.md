# macOS Desktop Release Signing and Notarization

Open Sprint macOS releases are distributed outside the Mac App Store, so Gatekeeper expects the app bundle to be signed with a `Developer ID Application` certificate and notarized by Apple before a new Mac will open it normally.

The GitHub Actions workflow at `.github/workflows/release-desktop.yml` is the supported release path for public macOS builds. It signs the `.app`, runs the repository `afterSign` notarization hook, staples the app before DMG packaging, validates the result, and then uploads the DMG to the GitHub Release.

## Required Apple Assets

You need all of the following before a tagged macOS release can succeed:

- An active Apple Developer Program membership
- A `Developer ID Application` certificate installed on a Mac
- A `.p12` export of that certificate plus its export password
- An App Store Connect API key with permission to submit notarization requests

## Export the Developer ID Certificate

On a Mac that has the `Developer ID Application` certificate installed:

1. Open Keychain Access.
2. Select `login` keychain, then `My Certificates`.
3. Find the `Developer ID Application` certificate for Open Sprint.
4. Export it as a `.p12` file and choose an export password.
5. Convert the `.p12` file to a single-line base64 string for GitHub Secrets:

```bash
base64 -i /path/to/OpenSprintDeveloperID.p12 | tr -d '\n'
```

Use that base64 output as the `CSC_LINK` GitHub secret. Electron Builder accepts `CSC_LINK` as base64-encoded certificate data.

## Create the App Store Connect API Key

Create the notarization key in App Store Connect:

1. Open `Users and Access`.
2. Open the `Integrations` tab, then `Keys`.
3. Create a team API key with `App Manager` access.
4. Save the `Key ID`, `Issuer ID`, and the downloaded `AuthKey_<KEY_ID>.p8` file.

The `.p8` file can only be downloaded once, so store it securely.

## Required GitHub Secrets

Configure these repository secrets before pushing a release tag:

- `CSC_LINK`: base64-encoded contents of the exported `.p12` certificate
- `CSC_KEY_PASSWORD`: password used when exporting the `.p12`
- `APPLE_API_KEY_ID`: App Store Connect API key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID
- `APPLE_API_KEY_P8`: raw contents of `AuthKey_<KEY_ID>.p8`

During the macOS job, the workflow writes `APPLE_API_KEY_P8` to a temporary `.p8` file under `$RUNNER_TEMP` and exports that path as `APPLE_API_KEY` for Electron Builder notarization.

## Release Flow

1. Push a version tag such as `v1.0.0`.
2. GitHub Actions creates the release shell.
3. The macOS job verifies that all required signing and notarization secrets are present.
4. The job writes the temporary App Store Connect key file, builds the macOS app, signs it, notarizes it, and staples the notarization ticket.
5. The job validates the built `.app` before uploading `packages/electron/dist/*.dmg` to the GitHub Release.

If any required secret is missing, the macOS release job fails before dependency install or packaging work begins.

The notarization hook submits once, captures the Apple submission ID, and then polls `xcrun notarytool info` every 30 seconds so the GitHub Actions logs keep showing status while Apple is still processing. By default it waits up to `90m`; override that by setting `OPENSPRINT_NOTARY_TIMEOUT` in the macOS job environment if Apple processing is unusually slow.

## Verification Commands

The CI workflow validates the packaged app with these commands before uploading the DMG:

```bash
codesign -dv --verbose=4 "packages/electron/dist/<...>/Open Sprint.app"
spctl -a -vvv -t exec "packages/electron/dist/<...>/Open Sprint.app"
xcrun stapler validate "packages/electron/dist/<...>/Open Sprint.app"
```

Expected results:

- `codesign` output includes `Authority=Developer ID Application` and a real `TeamIdentifier`, not `Signature=adhoc`
- `spctl` reports the app as accepted
- `xcrun stapler validate` succeeds

## macOS Development: "Electron quit unexpectedly"

When running `npm run start:desktop` on a Mac, the first time (or after a fresh `npm install`) the Electron binary from `node_modules` can trigger a system crash dialog: **"Electron quit unexpectedly."** This is usually due to macOS Gatekeeper or quarantine/provenance on the downloaded binary.

The root `start:desktop` script runs `scripts/fix-macos-electron-dev.sh` automatically. That script, on Darwin only:

1. Removes extended attributes (e.g. `com.apple.quarantine`, `com.apple.provenance`) from `node_modules/electron/dist/Electron.app`.
2. Re-applies ad-hoc code signing so the system allows the app to run.

If you still see the crash after that:

- Run the fix manually once: `bash scripts/fix-macos-electron-dev.sh`, then run `npm run start:desktop` again.
- Ensure you are not overriding `PATH` or running from a environment that changes how `codesign` or `xattr` behave.

This fix is for **development only**. Release builds are signed and notarized in CI as described above.

## Temporary Workaround for Older Unsigned DMGs

Older DMGs that were published before CI signing and notarization are still expected to trigger Gatekeeper warnings on a new Mac.

For those older builds only:

1. Control-click the app and choose `Open`, or
2. Open `System Settings` -> `Privacy & Security` and choose `Open Anyway`

That workaround should not be needed for releases produced by the updated GitHub Actions pipeline.
