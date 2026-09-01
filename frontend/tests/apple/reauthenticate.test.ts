import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  authenticate,
  type AuthenticationErrorKind,
} from "../../src/apple/authenticate";
import {
  reauthenticateAccount,
  ReauthenticationCodeRequiredError,
} from "../../src/apple/reauthenticate";
import type { Account } from "../../src/types";

vi.mock("../../src/apple/authenticate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/apple/authenticate")>();
  return { ...actual, authenticate: vi.fn() };
});

const account: Account = {
  email: "apple-id",
  password: "secret",
  appleId: "apple-id",
  store: "143463-2,34",
  firstName: "Test",
  lastName: "User",
  passwordToken: "old-token",
  directoryServicesIdentifier: "123",
  cookies: [
    {
      name: "session",
      value: "legacy",
      path: "/",
      httpOnly: true,
      secure: true,
    },
  ],
  deviceIdentifier: "AA:BB:CC:DD:EE:FF",
};

const updated = {
  ...account,
  passwordToken: "new-token",
  deviceIdentifier: "aabbccddeeff",
};

function authError(
  message: string,
  kind: AuthenticationErrorKind = "authentication",
  status = 401,
) {
  return new AuthenticationError(message, false, kind, status);
}

describe("reauthenticateAccount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses cached cookies exactly once when they succeed", async () => {
    vi.mocked(authenticate).mockResolvedValue(updated);
    await expect(reauthenticateAccount(account)).resolves.toBe(updated);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(authenticate).mock.calls[0][3]).toEqual(account.cookies);
  });

  it("does exactly one fresh retry after an Apple authentication failure", async () => {
    vi.mocked(authenticate)
      .mockRejectedValueOnce(authError("cached failed"))
      .mockResolvedValueOnce(updated);
    await expect(reauthenticateAccount(account)).resolves.toBe(updated);
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(authenticate).mock.calls[1][3]).toEqual([]);
  });

  it.each([502, 503, 504])(
    "does not fresh retry backend infrastructure HTTP %s",
    async (status) => {
      vi.mocked(authenticate).mockRejectedValue(
        authError("backend failed", "infrastructure", status),
      );
      await expect(reauthenticateAccount(account)).rejects.toThrow(
        "backend failed",
      );
      expect(authenticate).toHaveBeenCalledTimes(1);
    },
  );

  it("does not fresh retry a network failure", async () => {
    vi.mocked(authenticate).mockRejectedValue(
      authError("offline", "network", 0),
    );
    await expect(reauthenticateAccount(account)).rejects.toThrow("offline");
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("does not fresh retry an access middleware failure", async () => {
    vi.mocked(authenticate).mockRejectedValue(
      authError("Unauthorized", "unknown", 401),
    );
    await expect(reauthenticateAccount(account)).rejects.toThrow("Unauthorized");
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry a 2FA challenge", async () => {
    vi.mocked(authenticate).mockRejectedValue(
      new AuthenticationError("code required", true, "authentication", 401),
    );
    await expect(reauthenticateAccount(account)).rejects.toMatchObject({
      codeRequired: true,
      freshSession: true,
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("always submits a verification code against fresh cookies", async () => {
    vi.mocked(authenticate).mockResolvedValue(updated);
    await reauthenticateAccount(account, "123456", false);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith(
      account.email,
      account.password,
      "123456",
      [],
      expect.stringMatching(/^[0-9a-f]{12}$/),
    );
  });

  it("stops after a failed fresh authentication", async () => {
    vi.mocked(authenticate)
      .mockRejectedValueOnce(authError("cached failed"))
      .mockRejectedValueOnce(authError("fresh failed"));
    await expect(reauthenticateAccount(account)).rejects.toThrow("fresh failed");
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("does not automatically retry a failed 2FA submission", async () => {
    vi.mocked(authenticate).mockRejectedValue(authError("bad code"));
    await expect(
      reauthenticateAccount(account, "111111", true),
    ).rejects.toThrow("bad code");
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("generates a valid replacement for a malformed legacy device ID", async () => {
    vi.mocked(authenticate).mockResolvedValue(updated);
    await reauthenticateAccount({
      ...account,
      deviceIdentifier: "legacy-invalid",
    });
    const usedDeviceId = vi.mocked(authenticate).mock.calls[0][4];
    expect(usedDeviceId).toMatch(/^[0-9a-f]{12}$/);
    const first = parseInt(usedDeviceId.slice(0, 2), 16);
    expect(first & 0x01).toBe(0);
    expect(first & 0x02).toBe(0x02);
  });

  it("uses the dedicated challenge error type", async () => {
    vi.mocked(authenticate).mockRejectedValue(
      new AuthenticationError("code required", true, "authentication", 401),
    );
    await expect(reauthenticateAccount(account)).rejects.toBeInstanceOf(
      ReauthenticationCodeRequiredError,
    );
  });
});
