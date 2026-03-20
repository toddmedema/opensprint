import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sharedRoot = resolve(__dirname, "../..");
const repoRoot = resolve(sharedRoot, "../..");
const workflowPath = resolve(repoRoot, ".github/workflows/release-desktop.yml");

describe("desktop release workflow", () => {
  it("requires mac signing and notarization secrets before building the DMG", () => {
    const workflow = readFileSync(workflowPath, "utf-8");
    expect(workflow).toContain("Verify mac signing secrets");
    expect(workflow).toContain("CSC_LINK");
    expect(workflow).toContain("CSC_KEY_PASSWORD");
    expect(workflow).toContain("APPLE_API_KEY_ID");
    expect(workflow).toContain("APPLE_API_ISSUER");
    expect(workflow).toContain("APPLE_API_KEY_P8");
    expect(workflow).toContain("OPENSPRINT_NOTARY_TIMEOUT");
    expect(workflow).toContain("Missing required GitHub secret");
  });

  it("validates the signed and notarized app before uploading the DMG", () => {
    const workflow = readFileSync(workflowPath, "utf-8");
    expect(workflow).toContain("codesign -dv --verbose=4");
    expect(workflow).toContain("Authority=Developer ID Application");
    expect(workflow).toContain("spctl -a -vvv -t exec");
    expect(workflow).toContain("xcrun stapler validate");
  });
});
