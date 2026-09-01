import { spawn } from "child_process";
import { config } from "../config.js";

export interface SAPAuthCookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  hostOnly?: boolean;
  expiresAt?: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface SAPAuthRequest {
  email: string;
  password: string;
  authCode?: string;
  deviceId: string;
  existingCookies?: SAPAuthCookie[];
}

export interface SAPAuthAccount {
  email: string;
  appleId: string;
  store: string;
  firstName: string;
  lastName: string;
  passwordToken: string;
  directoryServicesIdentifier: string;
  cookies: SAPAuthCookie[];
  deviceIdentifier: string;
  pod?: string;
}

export type SAPAuthResultKind = "authentication" | "infrastructure" | "request";

export interface SAPAuthResult {
  account?: SAPAuthAccount;
  error?: string;
  kind?: SAPAuthResultKind;
  codeRequired?: boolean;
  eligibleForFreshRetry?: boolean;
}

export type SAPAuthServiceErrorKind =
  | "missing"
  | "timeout"
  | "oversized"
  | "empty"
  | "invalid-json"
  | "invalid-response"
  | "runtime"
  | "busy"
  | "aborted";

export interface SAPAuthRunOptions {
  signal?: AbortSignal;
}

export class SAPAuthServiceError extends Error {
  constructor(
    message: string,
    public readonly kind: SAPAuthServiceErrorKind,
  ) {
    super(message);
    this.name = "SAPAuthServiceError";
  }
}

export const MAX_HELPER_OUTPUT_BYTES = 1024 * 1024;

const SAP_AUTH_HELPER_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

let activeHelperCount = 0;

type SAPAuthLogValue = string | number | boolean | null | undefined;

function logSAPAuth(
  level: "info" | "warn" | "error",
  event: "start" | "success" | "failure",
  fields: Record<string, SAPAuthLogValue>,
): void {
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const message = `[sap-auth] ${event}${details ? ` ${details}` : ""}`;
  console[level](message);
}

function buildSAPAuthHelperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    XDG_CACHE_HOME:
      process.env.XDG_CACHE_HOME || `${config.dataDir}/cache`,
  };
  for (const key of SAP_AUTH_HELPER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSAPAuthResultKind(value: unknown): value is SAPAuthResultKind {
  return (
    value === "authentication" ||
    value === "infrastructure" ||
    value === "request"
  );
}

function isSAPAuthCookie(value: unknown): value is SAPAuthCookie {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.value === "string" &&
    typeof value.path === "string" &&
    (value.domain === undefined || typeof value.domain === "string") &&
    (value.hostOnly === undefined || typeof value.hostOnly === "boolean") &&
    (value.expiresAt === undefined ||
      (typeof value.expiresAt === "number" &&
        Number.isSafeInteger(value.expiresAt))) &&
    typeof value.httpOnly === "boolean" &&
    typeof value.secure === "boolean"
  );
}

function isSAPAuthAccount(value: unknown): value is SAPAuthAccount {
  if (!isRecord(value)) return false;
  return (
    typeof value.email === "string" &&
    typeof value.appleId === "string" &&
    typeof value.store === "string" &&
    typeof value.firstName === "string" &&
    typeof value.lastName === "string" &&
    typeof value.passwordToken === "string" &&
    typeof value.directoryServicesIdentifier === "string" &&
    Array.isArray(value.cookies) &&
    value.cookies.every(isSAPAuthCookie) &&
    typeof value.deviceIdentifier === "string" &&
    (value.pod === undefined || typeof value.pod === "string")
  );
}

function isSAPAuthResult(value: unknown): value is SAPAuthResult {
  if (!isRecord(value)) return false;

  if (value.account !== undefined) {
    return (
      isSAPAuthAccount(value.account) &&
      value.error === undefined &&
      value.kind === undefined &&
      value.codeRequired === undefined &&
      value.eligibleForFreshRetry === undefined
    );
  }

  return (
    typeof value.error === "string" &&
    value.error.length > 0 &&
    isSAPAuthResultKind(value.kind) &&
    (value.codeRequired === undefined ||
      typeof value.codeRequired === "boolean") &&
    (value.eligibleForFreshRetry === undefined ||
      typeof value.eligibleForFreshRetry === "boolean")
  );
}

function abortedError(): SAPAuthServiceError {
  return new SAPAuthServiceError(
    "SAP authentication request was cancelled",
    "aborted",
  );
}

function acquireHelperSlot(signal?: AbortSignal): () => void {
  if (signal?.aborted) {
    throw abortedError();
  }
  if (activeHelperCount >= config.sapAuthMaxConcurrency) {
    throw new SAPAuthServiceError(
      "SAP authentication helper is busy; try again shortly",
      "busy",
    );
  }

  activeHelperCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeHelperCount = Math.max(0, activeHelperCount - 1);
  };
}

export async function runSAPAuthentication(
  input: SAPAuthRequest,
  options: SAPAuthRunOptions = {},
): Promise<SAPAuthResult> {
  const releaseSlot = acquireHelperSlot(options.signal);
  try {
    return await runSAPAuthenticationWithSlot(input, options.signal);
  } finally {
    releaseSlot();
  }
}

function runSAPAuthenticationWithSlot(
  input: SAPAuthRequest,
  signal?: AbortSignal,
): Promise<SAPAuthResult> {
  const startedAt = Date.now();
  const durationMs = () => Date.now() - startedAt;
  logSAPAuth("info", "start", {
    existingCookieCount: input.existingCookies?.length ?? 0,
    hasAuthCode: Boolean(input.authCode?.trim()),
  });

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }

    const child = spawn(config.sapAuthHelperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSAPAuthHelperEnv(),
    });

    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let termination:
      | { error: SAPAuthServiceError; reason: string }
      | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      callback();
    };

    const terminate = (error: SAPAuthServiceError, reason: string) => {
      if (settled || termination) return;
      termination = { error, reason };
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      child.kill("SIGKILL");
    };

    abortHandler = () => {
      terminate(abortedError(), "request_aborted");
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    timeout = setTimeout(() => {
      terminate(
        new SAPAuthServiceError(
          "SAP authentication helper timed out",
          "timeout",
        ),
        "helper_timeout",
      );
    }, config.sapAuthTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || termination) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_HELPER_OUTPUT_BYTES) {
        terminate(
          new SAPAuthServiceError(
            "SAP authentication response is too large",
            "oversized",
          ),
          "helper_output_oversized",
        );
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled || termination) return;
      stderrBytes = Math.min(
        MAX_HELPER_OUTPUT_BYTES + 1,
        stderrBytes + Buffer.byteLength(chunk),
      );
      if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) {
        terminate(
          new SAPAuthServiceError(
            "SAP authentication helper diagnostic output is too large",
            "oversized",
          ),
          "helper_stderr_oversized",
        );
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        const missing = error.code === "ENOENT";
        logSAPAuth("error", "failure", {
          kind: "infrastructure",
          reason: missing ? "helper_not_found" : "helper_start_failed",
          durationMs: durationMs(),
          stderrBytes,
        });
        reject(
          new SAPAuthServiceError(
            missing
              ? "SAP authentication helper is not installed"
              : "SAP authentication helper could not be started",
            missing ? "missing" : "runtime",
          ),
        );
      });
    });
    child.on("close", (code, signalName) => {
      finish(() => {
        const exitFields = {
          durationMs: durationMs(),
          exitCode: code ?? "none",
          signal: signalName ?? "none",
          stderrBytes,
        };
        if (termination) {
          logSAPAuth("warn", "failure", {
            kind: "infrastructure",
            reason: termination.reason,
            ...exitFields,
          });
          reject(termination.error);
          return;
        }
        if (code !== 0 || signalName !== null) {
          logSAPAuth("error", "failure", {
            kind: "infrastructure",
            reason: "helper_failed",
            ...exitFields,
          });
          reject(
            new SAPAuthServiceError(
              "SAP authentication helper failed",
              "runtime",
            ),
          );
          return;
        }
        if (!stdout.trim()) {
          logSAPAuth("error", "failure", {
            kind: "infrastructure",
            reason: "helper_empty_response",
            ...exitFields,
          });
          reject(
            new SAPAuthServiceError(
              "SAP authentication helper returned no response",
              "empty",
            ),
          );
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          logSAPAuth("error", "failure", {
            kind: "infrastructure",
            reason: "helper_invalid_json",
            ...exitFields,
          });
          reject(
            new SAPAuthServiceError(
              "SAP authentication helper returned invalid JSON",
              "invalid-json",
            ),
          );
          return;
        }

        if (!isSAPAuthResult(parsed)) {
          logSAPAuth("error", "failure", {
            kind: "infrastructure",
            reason: "helper_invalid_response",
            ...exitFields,
          });
          reject(
            new SAPAuthServiceError(
              "SAP authentication helper returned an invalid response",
              "invalid-response",
            ),
          );
          return;
        }

        const result = parsed;
        if (result.account) {
          logSAPAuth("info", "success", {
            cookieCount: result.account.cookies.length,
            hasPod: Boolean(result.account.pod),
            hasStorefront: Boolean(result.account.store),
            ...exitFields,
          });
        } else {
          logSAPAuth("warn", "failure", {
            kind: result.kind ?? "infrastructure",
            reason: "helper_response",
            codeRequired: result.codeRequired === true,
            eligibleForFreshRetry: result.eligibleForFreshRetry === true,
            ...exitFields,
          });
        }
        resolve(result);
      });
    });

    child.stdin.on("error", () => {
      // A helper that exits early can close stdin before the write completes;
      // the process error/close event above remains the authoritative result.
    });
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    child.stdin.end(JSON.stringify(input));
  });
}
