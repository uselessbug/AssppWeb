import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../src/i18n";
import {
  authenticate,
  localizedAuthenticationFailureMessage,
  sanitizeExistingCookies,
} from "../../src/apple/authenticate";

vi.mock("../../src/api/client", () => ({
  authHeaders: () => ({ "X-Access-Token": "access-token" }),
}));

describe("sanitizeExistingCookies", () => {
  it("normalizes valid legacy cookies, preserves host-only metadata, and drops malformed entries", () => {
    const input = [
      { name: "ok", value: "1", path: "/x", domain: "apple.com", hostOnly: true, expiresAt: 10.8, httpOnly: true, secure: true },
      { name: "path", value: "2", path: 123, expiresAt: Infinity, httpOnly: "yes", secure: 1 },
      { name: "nan", value: "3", path: "/", expiresAt: NaN },
      null,
      { value: "missing-name" },
      { name: "missing-value" },
    ] as any;
    expect(sanitizeExistingCookies(input)).toEqual([
      { name: "ok", value: "1", path: "/x", domain: "apple.com", hostOnly: true, expiresAt: 10, httpOnly: true, secure: true },
      { name: "path", value: "2", path: "/", httpOnly: false, secure: false },
      { name: "nan", value: "3", path: "/", httpOnly: false, secure: false },
    ]);
  });
});

describe("authenticate", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage("en-US");
  });

  it("posts through the protected backend route and retains the local password", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        email: "id",
        appleId: "id",
        store: "143441",
        firstName: "A",
        lastName: "B",
        passwordToken: "token",
        directoryServicesIdentifier: "123",
        cookies: [],
        deviceIdentifier: "aabbccddeeff",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const account = await authenticate(
      "id",
      "secret",
      "12 34 56",
      [{ name: "session", value: "cookie", path: "/", httpOnly: false, secure: true }],
      "aabbccddeeff",
    );

    expect(account.password).toBe("secret");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/apple/authenticate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Access-Token": "access-token",
        }),
      }),
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      email: "id",
      password: "secret",
      authCode: "123456",
      deviceId: "aabbccddeeff",
      existingCookies: [
        {
          name: "session",
          value: "cookie",
          path: "/",
          httpOnly: false,
          secure: true,
        },
      ],
    });
  });

  it("localizes 2FA challenges without making them fresh-retry eligible", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "BACKEND_ENGLISH_SENTINEL",
        kind: "authentication",
        reason: "verification_required",
        codeRequired: true,
        eligibleForFreshRetry: false,
      }), { status: 401, headers: { "Content-Type": "application/json" } }),
    );
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({
      message: i18n.t("errors.auth.sapVerificationRequired"),
      codeRequired: true,
      kind: "authentication",
      eligibleForFreshRetry: false,
    });
    expect(i18n.t("errors.auth.sapVerificationRequired")).not.toBe(
      "BACKEND_ENGLISH_SENTINEL",
    );
  });

  it("preserves fresh-retry eligibility for ordinary authentication failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "bad credentials",
        kind: "authentication",
        reason: "authentication_failed",
        codeRequired: false,
        eligibleForFreshRetry: true,
      }), { status: 401, headers: { "Content-Type": "application/json" } }),
    );
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({
      kind: "authentication",
      codeRequired: false,
      eligibleForFreshRetry: true,
    });
  });

  it("localizes infrastructure reasons without making them fresh-retry eligible", async () => {
    await i18n.changeLanguage("ja");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "helper timed out",
        kind: "infrastructure",
        reason: "helper_timeout",
        eligibleForFreshRetry: false,
      }), { status: 504, headers: { "Content-Type": "application/json" } }),
    );
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({
      message: i18n.t("errors.auth.sapHelperTimeout"),
      kind: "infrastructure",
      codeRequired: false,
      eligibleForFreshRetry: false,
      status: 504,
    });
  });

  it("falls back safely when the backend reason is unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "backend fallback message",
        kind: "infrastructure",
        reason: "future_reason",
        eligibleForFreshRetry: false,
      }), { status: 502, headers: { "Content-Type": "application/json" } }),
    );

    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({
      message: "backend fallback message",
      kind: "infrastructure",
      eligibleForFreshRetry: false,
    });
    expect(
      localizedAuthenticationFailureMessage(
        "future_reason",
        "backend fallback message",
      ),
    ).toBe("backend fallback message");
  });

  it("does not trust authentication kind alone without retry eligibility", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "account disabled",
        kind: "authentication",
        reason: "authentication_failed",
        eligibleForFreshRetry: false,
      }), { status: 401, headers: { "Content-Type": "application/json" } }),
    );
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({
      kind: "authentication",
      eligibleForFreshRetry: false,
    });
  });

  it("does not make an access middleware 401 fresh-retry eligible", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({
      kind: "unknown",
      eligibleForFreshRetry: false,
      status: 401,
    });
  });

  it("classifies network failures separately", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({
      kind: "network",
      eligibleForFreshRetry: false,
    });
  });

  it("rejects malformed success responses as invalid responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ directoryServicesIdentifier: "123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({
      kind: "invalid-response",
      eligibleForFreshRetry: false,
    });
  });
});
