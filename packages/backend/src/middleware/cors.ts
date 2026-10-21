import cors from "cors";

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * CORS middleware restricted to localhost / 127.0.0.1 origins.
 *
 * Requests with no Origin header (server-to-server, curl, Electron same-origin)
 * are allowed through — the browser always attaches Origin on cross-origin
 * fetches, so omission means the caller is not a foreign web page.
 */
export const localhostCors = cors({
  origin(origin, callback) {
    if (
      !origin ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      origin === process.env.OPENSPRINT_PUBLIC_ORIGIN
    ) {
      callback(null, true);
    } else {
      callback(new Error("CORS request from disallowed origin"));
    }
  },
  credentials: true,
});
