import net from "net";

const DEFAULT_CONNECTIVITY_TARGET = "8.8.8.8:53";
const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 1_500;
const LOST_INTERNET_MESSAGE_PREFIX = "Lost internet connection.";

export interface ConnectivityCheckResult {
  reachable: boolean;
  target: string;
  reason?: string;
}

function readConnectivityTimeoutMs(): number {
  const raw = Number(process.env.OPENSPRINT_CONNECTIVITY_CHECK_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONNECTIVITY_TIMEOUT_MS;
  return Math.round(raw);
}

function readConnectivityTarget(): string {
  const raw =
    process.env.OPENSPRINT_CONNECTIVITY_CHECK_URL?.trim() ||
    process.env.OPENSPRINT_CONNECTIVITY_CHECK_TARGET?.trim() ||
    DEFAULT_CONNECTIVITY_TARGET;
  return raw;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function parseSocketTarget(value: string): { host: string; port: number; display: string } {
  const trimmed = value.trim();
  const [hostPart, portPart] = trimmed.split(":");
  const host = hostPart?.trim() || "8.8.8.8";
  const parsedPort = Number(portPart ?? "");
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 53;
  return {
    host,
    port,
    display: `${host}:${port}`,
  };
}

async function checkUrlConnectivity(
  url: string,
  timeoutMs: number
): Promise<ConnectivityCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    return {
      reachable: response.status > 0,
      target: url,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      reachable: false,
      target: url,
      reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkSocketConnectivity(
  host: string,
  port: number,
  timeoutMs: number,
  display: string
): Promise<ConnectivityCheckResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;

    const finish = (reachable: boolean, reason?: string): void => {
      if (done) return;
      done = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        reachable,
        target: display,
        ...(reason ? { reason } : {}),
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "connect timeout"));
    socket.once("error", (error) => finish(false, error.message));
  });
}

export async function checkInternetConnectivity(): Promise<ConnectivityCheckResult> {
  const target = readConnectivityTarget();
  const timeoutMs = readConnectivityTimeoutMs();
  if (isHttpUrl(target)) {
    return checkUrlConnectivity(target, timeoutMs);
  }
  const socketTarget = parseSocketTarget(target);
  return checkSocketConnectivity(
    socketTarget.host,
    socketTarget.port,
    timeoutMs,
    socketTarget.display
  );
}

export function buildLostInternetMessage(target: string): string {
  return `${LOST_INTERNET_MESSAGE_PREFIX} Open Sprint could not reach ${target}. Check your network and retry.`;
}

export function isLostInternetMessage(text: string): boolean {
  return text.toLowerCase().includes(LOST_INTERNET_MESSAGE_PREFIX.toLowerCase());
}
