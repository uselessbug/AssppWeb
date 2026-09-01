import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Software } from "../../src/types";
import {
  isPurchaseAuthExpired,
  purchaseApp,
  PurchaseError,
} from "../../src/apple/purchase";
import { appleRequest } from "../../src/apple/request";
import { buildPlist } from "../../src/apple/plist";

vi.mock("../../src/apple/request", () => ({ appleRequest: vi.fn() }));

const account: Account = {
  email: "test@example.com",
  password: "password",
  appleId: "test@example.com",
  store: "143463-2,34",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token",
  directoryServicesIdentifier: "123",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
  pod: "42",
};

const app: Software = {
  id: 123456,
  bundleID: "com.example.app",
  name: "Example",
  version: "1.0",
  artistName: "Example Inc.",
  sellerName: "Example Inc.",
  description: "Example app",
  averageUserRating: 0,
  userRatingCount: 0,
  artworkUrl: "",
  screenshotUrls: [],
  minimumOsVersion: "15.0",
  releaseDate: "2026-06-12T00:00:00Z",
  primaryGenreName: "Utilities",
  price: 0,
};

function response(body: Record<string, unknown>, status = 200) {
  return {
    status,
    statusText: status === 200 ? "OK" : "Internal Server Error",
    headers: {},
    rawHeaders: [],
    body: buildPlist(body),
  };
}

async function captureError(body: Record<string, unknown>, status = 200) {
  vi.mocked(appleRequest).mockResolvedValueOnce(response(body, status));
  try {
    await purchaseApp(account, app);
  } catch (error) {
    return error;
  }
  throw new Error("expected purchase to fail");
}

describe("apple purchase migration semantics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the SAP storefront descriptor verbatim", async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(
      response({ jingleDocType: "purchaseSuccess", status: 0 }),
    );
    await purchaseApp(account, app);
    expect(
      vi.mocked(appleRequest).mock.calls[0][0].headers?.[
        "X-Apple-Store-Front"
      ],
    ).toBe("143463-2,34");
  });

  it("classifies PasswordChanged without failureType as auth expired", async () => {
    const error = await captureError({
      customerMessage: "Your password has changed.",
    });
    expect(isPurchaseAuthExpired(error)).toBe(true);
    expect((error as PurchaseError).code).toBe("2034");
  });

  it("does not hide PasswordChanged behind HTTP 500 already-owned fallback", async () => {
    const error = await captureError(
      { customerMessage: "Your password has changed." },
      500,
    );
    expect(isPurchaseAuthExpired(error)).toBe(true);
  });

  it.each([200, 500])(
    "classifies Subscription Required without failureType at HTTP %s",
    async (status) => {
      const error = await captureError(
        { customerMessage: "Subscription Required" },
        status,
      );
      expect(error).toBeInstanceOf(PurchaseError);
      expect(isPurchaseAuthExpired(error)).toBe(false);
    },
  );

  it.each([200, 500])(
    "classifies termsPage without failureType at HTTP %s",
    async (status) => {
      const error = await captureError(
        { action: { URL: "https://example.apple.com/termsPage" } },
        status,
      );
      expect(error).toBeInstanceOf(PurchaseError);
      expect((error as Error).message).toContain(
        "https://example.apple.com/termsPage",
      );
    },
  );

  it("treats failureType 5002 as an already-owned success", async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(
      response({ failureType: "5002" }, 500),
    );
    await expect(purchaseApp(account, app)).resolves.toEqual({
      updatedCookies: [],
    });
  });

  it("treats only a semantically bare HTTP 500 as already-owned", async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response({}, 500));
    await expect(purchaseApp(account, app)).resolves.toEqual({
      updatedCookies: [],
    });
  });

  it("does not hide an arbitrary customerMessage behind the HTTP 500 fallback", async () => {
    const error = await captureError(
      { customerMessage: "A specific Apple failure" },
      500,
    );
    expect(error).toBeInstanceOf(PurchaseError);
    expect((error as Error).message).toBe("A specific Apple failure");
  });

  it("does not hide explicit 2034 behind the HTTP 500 fallback", async () => {
    const error = await captureError({ failureType: "2034" }, 500);
    expect(isPurchaseAuthExpired(error)).toBe(true);
    expect((error as PurchaseError).code).toBe("2034");
  });

  it("classifies device verification failure as auth expiry", async () => {
    const error = await captureError({ failureType: "1008" }, 500);
    expect(isPurchaseAuthExpired(error)).toBe(true);
    expect((error as PurchaseError).code).toBe("1008");
  });
});
