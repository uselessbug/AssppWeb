import { authHeaders } from "../api/client";
import i18n from "../i18n";
import type { Account, Cookie } from "../types";

export type AuthenticationErrorKind =
  | "authentication"
  | "infrastructure"
  | "request"
  | "network"
  | "invalid-response"
  | "unknown";

export type AuthenticationFailureReason =
  | "verification_required"
  | "authentication_failed"
  | "invalid_request"
  | "helper_not_found"
  | "helper_timeout"
  | "helper_invalid_response"
  | "helper_busy"
  | "access_protection_required"
  | "helper_failed";

const AUTH_FAILURE_I18N_KEYS: Record<AuthenticationFailureReason, string> = {
  verification_required: "errors.auth.sapVerificationRequired",
  authentication_failed: "errors.auth.sapAuthenticationFailed",
  invalid_request: "errors.auth.sapInvalidRequest",
  helper_not_found: "errors.auth.sapHelperNotFound",
  helper_timeout: "errors.auth.sapHelperTimeout",
  helper_invalid_response: "errors.auth.sapHelperInvalidResponse",
  helper_busy: "errors.auth.sapHelperBusy",
  access_protection_required: "errors.auth.sapAccessProtectionRequired",
  helper_failed: "errors.auth.sapHelperFailed",
};

export function localizedAuthenticationFailureMessage(
  reason: string | undefined,
  fallback: string,
): string {
  if (reason && reason in AUTH_FAILURE_I18N_KEYS) {
    return i18n.t(
      AUTH_FAILURE_I18N_KEYS[reason as AuthenticationFailureReason],
    );
  }
  return fallback;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
    public readonly kind: AuthenticationErrorKind = "unknown",
    public readonly status?: number,
    public readonly freshRetryEligible: boolean = kind === "authentication",
  ) {
    super(message);
    this.name = "AuthenticationError";
  }

  get eligibleForFreshRetry(): boolean {
    return (
      this.kind === "authentication" &&
      !this.codeRequired &&
      this.freshRetryEligible
    );
  }
}

interface AuthenticationFailure {
  error?: string;
  kind?: AuthenticationErrorKind;
  reason?: string;
  codeRequired?: boolean;
  eligibleForFreshRetry?: boolean;
}

type AuthenticatedAccount = Omit<Account, "password">;

export function sanitizeExistingCookies(cookies: Cookie[] | undefined): Cookie[] {
  if (!Array.isArray(cookies)) return [];
  return cookies.flatMap((cookie) => {
    if (
      !cookie ||
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string"
    ) {
      return [];
    }
    const expiresAt =
      typeof cookie.expiresAt === "number" && Number.isFinite(cookie.expiresAt)
        ? Math.trunc(cookie.expiresAt)
        : undefined;
    return [
      {
        name: cookie.name,
        value: cookie.value,
        path:
          typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
        ...(typeof cookie.domain === "string" && cookie.domain
          ? { domain: cookie.domain }
          : {}),
        ...(cookie.hostOnly === true ? { hostOnly: true } : {}),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        httpOnly: cookie.httpOnly === true,
        secure: cookie.secure === true,
      },
    ];
  });
}

/** Authenticate through the server-side ipatool v2.4 SAP helper. */
export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
): Promise<Account> {
  let response: Response;
  try {
    response = await fetch("/api/apple/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        email,
        password,
        authCode: code?.replace(/ /g, ""),
        deviceId,
        existingCookies: sanitizeExistingCookies(existingCookies),
      }),
    });
  } catch (error) {
    throw new AuthenticationError(
      error instanceof Error ? error.message : String(error),
      false,
      "network",
    );
  }

  if (!response.ok) {
    const failure = (await response.json().catch(() => ({
      error: response.statusText,
    }))) as AuthenticationFailure;
    const kind =
      failure.kind === "authentication" ||
      failure.kind === "infrastructure" ||
      failure.kind === "request"
        ? failure.kind
        : "unknown";
    const fallback = failure.error || "Apple authentication failed";
    throw new AuthenticationError(
      localizedAuthenticationFailureMessage(failure.reason, fallback),
      failure.codeRequired === true,
      kind,
      response.status,
      failure.eligibleForFreshRetry === true,
    );
  }

  const account = (await response.json()) as AuthenticatedAccount;
  if (!account.passwordToken || !account.directoryServicesIdentifier) {
    throw new AuthenticationError(
      "Login response did not include an App Store session token",
      false,
      "invalid-response",
      response.status,
    );
  }

  return { ...account, email, password };
}
