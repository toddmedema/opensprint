import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SPA_INDEX_BOOT_INLINE_STYLE_SHA256,
  buildSpaContentSecurityPolicyProduction,
  buildSpaContentSecurityPolicyViteDevelopment,
} from "../spa-content-security-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function cspSha256SourceToken(body: string): string {
  const digest = createHash("sha256").update(body, "utf8").digest("base64");
  return `sha256-${digest}`;
}

function readFrontendIndexHtml(): string {
  const indexPath = join(__dirname, "../../../frontend/index.html");
  return readFileSync(indexPath, "utf8");
}

describe("spa-content-security-policy", () => {
  it.each(["\n", "\r\n", "\r"])(
    "keeps the boot style hash aligned for HTML line endings %j",
    (eol) => {
      const html = readFrontendIndexHtml().replace(/\r\n?/g, "\n").replace(/\n/g, eol);
      const start = html.indexOf("<style>");
      const end = html.indexOf("</style>");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      // HTML parsing normalizes CRLF and lone CR before CSP hashes the style text.
      const inner = html.slice(start + "<style>".length, end).replace(/\r\n?/g, "\n");
      expect(cspSha256SourceToken(inner)).toBe(SPA_INDEX_BOOT_INLINE_STYLE_SHA256);
    }
  );

  it("buildSpaContentSecurityPolicyProduction includes hashed style, tight script-src, and markdown-friendly img-src", () => {
    const csp = buildSpaContentSecurityPolicyProduction();
    expect(csp).toContain(`'${SPA_INDEX_BOOT_INLINE_STYLE_SHA256}'`);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("buildSpaContentSecurityPolicyProduction embeds a desktop session nonce when provided", () => {
    const csp = buildSpaContentSecurityPolicyProduction({
      desktopSessionScriptNonce: "abc123",
    });
    expect(csp).toContain("script-src 'self' 'nonce-abc123'");
  });

  it("buildSpaContentSecurityPolicyViteDevelopment allows eval and backend proxy targets", () => {
    const csp = buildSpaContentSecurityPolicyViteDevelopment();
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("http://localhost:3100");
    expect(csp).toContain("ws://127.0.0.1:3100");
  });
});
