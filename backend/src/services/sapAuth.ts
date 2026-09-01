import { spawn } from "child_process";
import { config } from "../config.js";

export interface SAPAuthCookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
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

export interface SAPAuthResult {
  account?: SAPAuthAccount;
  error?: string;
  codeRequired?: boolean;
}

export type SAPAuthServiceErrorKind =
  | "missing"
  | "timeout"
  | "oversized"
  | "empty"
  | "invalid-json"
  | "runtime";

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

export function runSAPAuthentication(
  input: SAPAuthRequest,
): Promise<SAPAuthResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.sapAuthHelperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_CACHE_HOME:
          process.env.XDG_CACHE_HOME || `${config.dataDir}/cache`,
      },
    });

    let stdout = "";
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new SAPAuthServiceError(
            "SAP authentication helper timed out",
            "timeout",
          ),
        ),
      );
    }, config.sapAuthTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new SAPAuthServiceError(
              "SAP authentication response is too large",
              "oversized",
            ),
          ),
        );
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes = Math.min(
        MAX_HELPER_OUTPUT_BYTES + 1,
        stderrBytes + Buffer.byteLength(chunk),
      );
      if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new SAPAuthServiceError(
              "SAP authentication helper diagnostic output is too large",
              "oversized",
            ),
          ),
        );
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new SAPAuthServiceError(
            error.code === "ENOENT"
              ? "SAP authentication helper is not installed"
              : "SAP authentication helper could not be started",
            error.code === "ENOENT" ? "missing" : "runtime",
          ),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (!stdout.trim()) {
          reject(
            new SAPAuthServiceError(
              code === 0
                ? "SAP authentication helper returned no response"
                : "SAP authentication helper failed",
              code === 0 ? "empty" : "runtime",
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as SAPAuthResult);
        } catch {
          reject(
            new SAPAuthServiceError(
              "SAP authentication helper returned invalid JSON",
              "invalid-json",
            ),
          );
        }
      });
    });

    child.stdin.on("error", () => {
      // A helper that exits early can close stdin before the write completes;
      // the process error/close event above remains the authoritative result.
    });
    child.stdin.end(JSON.stringify(input));
  });
}
