import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Software } from "../../src/types";
import { getDownloadInfo, isDownloadAuthExpired } from "../../src/apple/download";
import { isVersionAuthExpired, listVersions } from "../../src/apple/versionFinder";
import { appleRequest } from "../../src/apple/request";
import { buildPlist } from "../../src/apple/plist";

vi.mock("../../src/apple/request", () => ({ appleRequest: vi.fn() }));

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

async function downloadError(body: Record<string, unknown>) {
  vi.mocked(appleRequest).mockResolvedValueOnce(response(body));
  try {
    await getDownloadInfo(account, app);
  } catch (error) {
    return error;
  }
  throw new Error("expected download to fail");
}

async function versionError(body: Record<string, unknown>) {
  vi.mocked(appleRequest).mockResolvedValueOnce(response(body));
  try {
    await listVersions(account, app);
  } catch (error) {
    return error;
  }
  throw new Error("expected version lookup to fail");
}

describe("download auth-expiry semantics", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["2034", "2042", "1008"])("classifies %s as auth expired", async (failureType) => {
    expect(isDownloadAuthExpired(await downloadError({ failureType }))).toBe(true);
  });

  it("classifies PasswordChanged without failureType as auth expired", async () => {
    expect(
      isDownloadAuthExpired(
        await downloadError({ customerMessage: "Your password has changed." }),
      ),
    ).toBe(true);
  });

  it("keeps 5002 redownload fallback", async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ failureType: "5002" }))
      .mockResolvedValueOnce(
        response({
          songList: [
            {
              URL: "https://example.com/app.ipa",
              metadata: {
                bundleShortVersionString: "1.0",
                bundleVersion: "100",
              },
              sinfs: [{ id: 1, sinf: "AQID" }],
            },
          ],
        }),
      );
    await expect(getDownloadInfo(account, app)).resolves.toMatchObject({
      output: { downloadURL: "https://example.com/app.ipa" },
    });
    expect(vi.mocked(appleRequest).mock.calls[1][0].host).toBe(
      "downloaddispatch.itunes.apple.com",
    );
  });
});

describe("version finder auth-expiry semantics", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["2034", "2042", "1008"])("classifies %s as auth expired", async (failureType) => {
    expect(isVersionAuthExpired(await versionError({ failureType }))).toBe(true);
  });

  it("classifies auth expiry before a stray songList", async () => {
    expect(
      isVersionAuthExpired(
        await versionError({
          failureType: "2034",
          songList: [
            { metadata: { softwareVersionExternalIdentifiers: [111] } },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("classifies PasswordChanged without failureType as auth expired", async () => {
    expect(
      isVersionAuthExpired(
        await versionError({ customerMessage: "Your password has changed." }),
      ),
    ).toBe(true);
  });

  it("keeps 5002 redownload fallback", async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ failureType: "5002" }))
      .mockResolvedValueOnce(
        response({
          songList: [
            { metadata: { softwareVersionExternalIdentifiers: [111, 222] } },
          ],
        }),
      );
    await expect(listVersions(account, app)).resolves.toMatchObject({
      versions: ["222", "111"],
    });
    expect(vi.mocked(appleRequest).mock.calls[1][0].host).toBe(
      "downloaddispatch.itunes.apple.com",
    );
  });
});
