import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate, AuthenticationError, sanitizeExistingCookies } from "./authenticate";

vi.mock("../api/client", () => ({
  authHeaders: () => ({ "X-Access-Token": "access-token" }),
}));

describe("sanitizeExistingCookies", () => {
  it("normalizes valid legacy cookies and drops malformed entries", () => {
    const input = [
      { name: "ok", value: "1", path: "/x", domain: "apple.com", expiresAt: 10.8, httpOnly: true, secure: true },
      { name: "path", value: "2", path: 123, expiresAt: Infinity, httpOnly: "yes", secure: 1 },
      null,
      { value: "missing-name" },
    ] as any;
    expect(sanitizeExistingCookies(input)).toEqual([
      { name: "ok", value: "1", path: "/x", domain: "apple.com", expiresAt: 10, httpOnly: true, secure: true },
      { name: "path", value: "2", path: "/", httpOnly: false, secure: false },
    ]);
  });
});

describe("authenticate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts through the protected backend route and retains the local password", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      email: "id",
      appleId: "id",
      store: "143441",
      firstName: "A",
      lastName: "B",
      passwordToken: "token",
      directoryServicesIdentifier: "123",
      cookies: [],
      deviceIdentifier: "aabbccddeeff",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const account = await authenticate("id", "secret", undefined, [], "aabbccddeeff");
    expect(account.password).toBe("secret");
    expect(fetchMock).toHaveBeenCalledWith("/api/apple/authenticate", expect.objectContaining({
      headers: expect.objectContaining({ "X-Access-Token": "access-token" }),
    }));
  });

  it("surfaces 2FA challenges", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "code required", codeRequired: true }), { status: 401, headers: { "Content-Type": "application/json" } }));
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toMatchObject({ codeRequired: true });
  });

  it("rejects success responses without session tokens", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ directoryServicesIdentifier: "123" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(authenticate("id", "secret", undefined, [], "aabbccddeeff")).rejects.toBeInstanceOf(AuthenticationError);
  });
});
