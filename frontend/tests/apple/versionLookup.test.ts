import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Software } from "../../src/types";
import { appleRequest } from "../../src/apple/request";
import { apiPost } from "../../src/api/client";
import { buildPlist } from "../../src/apple/plist";
import {
  getVersionMetadata,
  isVersionLookupAuthExpired,
  VersionLookupError,
} from "../../src/apple/versionLookup";
import { getVersionMetadataWithReauth } from "../../src/apple/versionMetadataFlow";
import { reauthenticateAccount } from "../../src/apple/reauthenticate";

vi.mock("../../src/apple/request", () => ({ appleRequest: vi.fn() }));
vi.mock("../../src/api/client", () => ({ apiPost: vi.fn() }));
vi.mock("../../src/apple/reauthenticate", () => ({
  reauthenticateAccount: vi.fn(),
}));

const account: Account = {
  email: "test@example.com",
  password: "password",
  appleId: "test@example.com",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token",
  directoryServicesIdentifier: "123",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
  pod: "42",
};
const renewed = { ...account, passwordToken: "renewed" };
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
};

function response(body: Record<string, unknown>) {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    rawHeaders: [],
    body: buildPlist(body),
  };
}

async function captureLookupError(body: Record<string, unknown>) {
  vi.mocked(appleRequest).mockResolvedValueOnce(response(body));
  try {
    await getVersionMetadata(account, app, "123");
  } catch (error) {
    return error;
  }
  throw new Error("expected version metadata lookup to fail");
}

describe("version metadata auth-expiry semantics", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["2034", "2042", "1008"])("classifies %s as auth expired", async (failureType) => {
    expect(
      isVersionLookupAuthExpired(await captureLookupError({ failureType })),
    ).toBe(true);
  });

  it("classifies PasswordChanged without failureType as auth expired", async () => {
    expect(
      isVersionLookupAuthExpired(
        await captureLookupError({
          customerMessage: "Your password has changed.",
        }),
      ),
    ).toBe(true);
  });

  it("keeps 5002 redownload fallback", async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ failureType: "5002" }))
      .mockResolvedValueOnce(
        response({ songList: [{ URL: "https://example.com/app.ipa" }] }),
      );
    vi.mocked(apiPost).mockResolvedValue({
      displayVersion: "1.0",
      releaseDate: "2026-06-12T00:00:00Z",
    });
    await expect(getVersionMetadata(account, app, "123")).resolves.toMatchObject({
      metadata: { displayVersion: "1.0" },
    });
    expect(vi.mocked(appleRequest).mock.calls[1][0].host).toBe(
      "downloaddispatch.itunes.apple.com",
    );
  });
});

describe("version metadata reauthentication flow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reauthenticates once, persists the account, and retries metadata once", async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ failureType: "2034" }))
      .mockResolvedValueOnce(
        response({ songList: [{ URL: "https://example.com/app.ipa" }] }),
      );
    vi.mocked(apiPost).mockResolvedValue({
      displayVersion: "2.0",
      releaseDate: "2026-06-12T00:00:00Z",
    });
    vi.mocked(reauthenticateAccount).mockResolvedValue(renewed);
    const persist = vi.fn().mockResolvedValue(undefined);

    const result = await getVersionMetadataWithReauth(
      account,
      app,
      "123",
      persist,
    );

    expect(reauthenticateAccount).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(renewed);
    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(result.account).toBe(renewed);
  });

  it("does not reauthenticate for ordinary metadata errors", async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response({}));
    const persist = vi.fn().mockResolvedValue(undefined);
    await expect(
      getVersionMetadataWithReauth(account, app, "123", persist),
    ).rejects.toBeInstanceOf(VersionLookupError);
    expect(reauthenticateAccount).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it("stops after one metadata retry", async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ failureType: "2034" }))
      .mockResolvedValueOnce(response({ failureType: "2034" }));
    vi.mocked(reauthenticateAccount).mockResolvedValue(renewed);
    const persist = vi.fn().mockResolvedValue(undefined);
    await expect(
      getVersionMetadataWithReauth(account, app, "123", persist),
    ).rejects.toBeInstanceOf(VersionLookupError);
    expect(reauthenticateAccount).toHaveBeenCalledTimes(1);
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });
});
