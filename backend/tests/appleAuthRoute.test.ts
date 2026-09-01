import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import appleAuthRoutes, { sanitizeCookies } from "../src/routes/appleAuth.js";
import {
  runSAPAuthentication,
  SAPAuthServiceError,
} from "../src/services/sapAuth.js";

vi.mock("../src/services/sapAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/sapAuth.js")>();
  return { ...actual, runSAPAuthentication: vi.fn() };
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", appleAuthRoutes);
  return app;
}

const validRequest = {
  email: "id",
  password: "secret",
  deviceId: "aabbccddeeff",
};

describe("sanitizeCookies", () => {
  it("sanitizes legacy cookie shapes, preserves host-only metadata, and drops malformed entries", () => {
    const result = sanitizeCookies([
      { name: "ok", value: "1", path: "/x", domain: "apple.com", hostOnly: true, expiresAt: 12.9, httpOnly: true, secure: true },
      { name: "missingPath", value: "2" },
      { name: "badPath", value: "3", path: 123, expiresAt: Infinity, httpOnly: "yes", secure: 1 },
      { name: "nanExpiry", value: "4", path: "/", expiresAt: NaN },
      null,
      { value: "missingName" },
      { name: "missingValue" },
    ]);
    expect(result).toEqual([
      { name: "ok", value: "1", path: "/x", domain: "apple.com", hostOnly: true, expiresAt: 12, httpOnly: true, secure: true },
      { name: "missingPath", value: "2", path: "/", httpOnly: false, secure: false },
      { name: "badPath", value: "3", path: "/", httpOnly: false, secure: false },
      { name: "nanExpiry", value: "4", path: "/", httpOnly: false, secure: false },
    ]);
  });
});

describe("Apple SAP authentication route", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ email: "", password: "secret", deviceId: "aabbccddeeff" }],
    [{ email: "apple-id", password: "", deviceId: "aabbccddeeff" }],
    [{ email: "apple-id", password: "secret", deviceId: "bad" }],
  ])("rejects invalid request %#", async (body) => {
    const response = await request(createApp())
      .post("/api/apple/authenticate")
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body.kind).toBe("request");
    expect(response.body.reason).toBe("invalid_request");
    expect(response.body.eligibleForFreshRetry).toBe(false);
    expect(runSAPAuthentication).not.toHaveBeenCalled();
  });

  it("accepts a non-email Apple ID, sanitizes cookies, and passes a cancellation signal", async () => {
    vi.mocked(runSAPAuthentication).mockResolvedValue({ account: helperAccount() });
    const response = await request(createApp())
      .post("/api/apple/authenticate")
      .send({
        email: " apple-id ",
        password: "secret",
        deviceId: "AABBCCDDEEFF",
        existingCookies: [{ name: "x", value: "y", path: 4, expiresAt: null, hostOnly: true }],
      });
    expect(response.status).toBe(200);
    expect(runSAPAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "apple-id",
        deviceId: "aabbccddeeff",
        existingCookies: [{ name: "x", value: "y", path: "/", hostOnly: true, httpOnly: false, secure: false }],
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("marks helper-declared Apple authentication failures as retry-eligible", async () => {
    vi.mocked(runSAPAuthentication).mockResolvedValueOnce({
      error: "bad credentials",
      kind: "authentication",
      eligibleForFreshRetry: true,
    });
    const response = await request(createApp())
      .post("/api/apple/authenticate")
      .send(validRequest);
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      kind: "authentication",
      reason: "authentication_failed",
      codeRequired: false,
      eligibleForFreshRetry: true,
    });
  });

  it("keeps 2FA challenges non-retryable until the user submits a code", async () => {
    vi.mocked(runSAPAuthentication).mockResolvedValueOnce({
      error: "code required",
      kind: "authentication",
      codeRequired: true,
      eligibleForFreshRetry: false,
    });
    const response = await request(createApp())
      .post("/api/apple/authenticate")
      .send(validRequest);
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      kind: "authentication",
      reason: "verification_required",
      codeRequired: true,
      eligibleForFreshRetry: false,
    });
  });

  it("does not convert helper-declared infrastructure errors into authentication failures", async () => {
    vi.mocked(runSAPAuthentication).mockResolvedValueOnce({
      error: "request failed",
      kind: "infrastructure",
    });
    const response = await request(createApp())
      .post("/api/apple/authenticate")
      .send(validRequest);
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      kind: "infrastructure",
      reason: "helper_failed",
      eligibleForFreshRetry: false,
    });
  });

  it.each([
    ["runtime", 502, "helper_failed"],
    ["oversized", 502, "helper_invalid_response"],
    ["empty", 502, "helper_invalid_response"],
    ["invalid-json", 502, "helper_invalid_response"],
    ["missing", 503, "helper_not_found"],
    ["timeout", 504, "helper_timeout"],
    ["busy", 503, "helper_busy"],
  ] as const)("marks %s helper failures as infrastructure errors", async (kind, status, reason) => {
    vi.mocked(runSAPAuthentication).mockRejectedValueOnce(
      new SAPAuthServiceError("helper failed", kind),
    );
    const response = await request(createApp())
      .post("/api/apple/authenticate")
      .send(validRequest);
    expect(response.status).toBe(status);
    expect(response.body.kind).toBe("infrastructure");
    expect(response.body.reason).toBe(reason);
    expect(response.body.eligibleForFreshRetry).toBe(false);
    if (kind === "busy") {
      expect(response.headers["retry-after"]).toBe("1");
    }
  });
});

function helperAccount() {
  return {
    email: "apple-id",
    appleId: "apple-id",
    store: "143441",
    firstName: "Test",
    lastName: "User",
    passwordToken: "token",
    directoryServicesIdentifier: "123",
    cookies: [],
    deviceIdentifier: "aabbccddeeff",
  };
}
