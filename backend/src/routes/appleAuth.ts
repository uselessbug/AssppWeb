import { Router, type Request, type Response } from "express";
import {
  runSAPAuthentication,
  SAPAuthServiceError,
  type SAPAuthCookie,
  type SAPAuthRequest,
  type SAPAuthResultKind,
} from "../services/sapAuth.js";

const router = Router();

export type SAPAuthFailureReason =
  | "verification_required"
  | "authentication_failed"
  | "invalid_request"
  | "helper_not_found"
  | "helper_timeout"
  | "helper_invalid_response"
  | "helper_busy"
  | "helper_failed";

function helperFailureReason(kind: SAPAuthServiceError["kind"]): SAPAuthFailureReason {
  switch (kind) {
    case "missing":
      return "helper_not_found";
    case "timeout":
      return "helper_timeout";
    case "empty":
    case "invalid-json":
    case "invalid-response":
    case "oversized":
      return "helper_invalid_response";
    case "busy":
      return "helper_busy";
    case "aborted":
    case "runtime":
    default:
      return "helper_failed";
  }
}

function resultFailureReason(
  kind: SAPAuthResultKind,
  codeRequired: boolean,
): SAPAuthFailureReason {
  if (codeRequired) return "verification_required";
  if (kind === "authentication") return "authentication_failed";
  if (kind === "request") return "invalid_request";
  return "helper_failed";
}

export function sanitizeCookies(value: unknown): SAPAuthCookie[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((cookie) => {
    if (!cookie || typeof cookie !== "object") return [];
    const item = cookie as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.value !== "string") {
      return [];
    }
    const expiresAt =
      typeof item.expiresAt === "number" && Number.isFinite(item.expiresAt)
        ? Math.trunc(item.expiresAt)
        : undefined;
    return [
      {
        name: item.name,
        value: item.value,
        path: typeof item.path === "string" && item.path ? item.path : "/",
        ...(typeof item.domain === "string" && item.domain
          ? { domain: item.domain }
          : {}),
        ...(item.hostOnly === true ? { hostOnly: true } : {}),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        httpOnly: item.httpOnly === true,
        secure: item.secure === true,
      },
    ];
  });
}

router.post("/apple/authenticate", async (req: Request, res: Response) => {
  const input = (req.body ?? {}) as Partial<SAPAuthRequest>;
  if (
    typeof input.email !== "string" ||
    typeof input.password !== "string" ||
    typeof input.deviceId !== "string" ||
    !input.email.trim() ||
    !input.password ||
    !/^[a-fA-F0-9]{12}$/.test(input.deviceId)
  ) {
    res.status(400).json({
      error: "Invalid Apple authentication request",
      kind: "request",
      reason: "invalid_request" satisfies SAPAuthFailureReason,
      eligibleForFreshRetry: false,
    });
    return;
  }

  const abortController = new AbortController();
  const abortRequest = () => abortController.abort();
  const abortIfResponseClosedEarly = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.once("aborted", abortRequest);
  res.once("close", abortIfResponseClosedEarly);
  if (req.aborted || res.destroyed) {
    abortRequest();
  }

  try {
    const result = await runSAPAuthentication(
      {
        email: input.email.trim(),
        password: input.password,
        authCode:
          typeof input.authCode === "string" ? input.authCode : undefined,
        deviceId: input.deviceId.toLowerCase(),
        existingCookies: sanitizeCookies(input.existingCookies),
      },
      { signal: abortController.signal },
    );

    if (!result.account) {
      const kind =
        result.kind === "authentication" || result.kind === "request"
          ? result.kind
          : "infrastructure";
      const codeRequired = result.codeRequired === true;
      const status = kind === "authentication" ? 401 : kind === "request" ? 400 : 502;
      res.status(status).json({
        error: result.error || "Apple authentication failed",
        kind,
        reason: resultFailureReason(kind, codeRequired),
        codeRequired,
        eligibleForFreshRetry:
          kind === "authentication" &&
          !codeRequired &&
          result.eligibleForFreshRetry === true,
      });
      return;
    }

    res.json(result.account);
  } catch (error) {
    if (error instanceof SAPAuthServiceError) {
      if (error.kind === "aborted") {
        return;
      }
      if (error.kind === "busy") {
        res.set("Retry-After", "1");
      }
      const status =
        error.kind === "missing" || error.kind === "busy"
          ? 503
          : error.kind === "timeout"
            ? 504
            : 502;
      res.status(status).json({
        error: error.message,
        kind: "infrastructure",
        reason: helperFailureReason(error.kind),
        eligibleForFreshRetry: false,
      });
      return;
    }
    res.status(502).json({
      error: "SAP authentication failed",
      kind: "infrastructure",
      reason: "helper_failed" satisfies SAPAuthFailureReason,
      eligibleForFreshRetry: false,
    });
  } finally {
    req.off("aborted", abortRequest);
    res.off("close", abortIfResponseClosedEarly);
  }
});

export default router;
