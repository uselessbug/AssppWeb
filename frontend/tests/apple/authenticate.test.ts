import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { authenticate } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { registerBrowserSapSignerFactory } from "../../src/apple/sap";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("aabbccddeeff");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });

  it("adds a browser-generated SAP signature to the exact login plist", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      sapConfig: {
        setupURL: "https://example.apple.com/setup",
        certificateURL: "https://example.apple.com/cert",
        version: 200,
      },
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    const sign = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const close = vi.fn(async () => undefined);
    const factory = vi.fn(async () => ({ sign, close }));
    const unregister = registerBrowserSapSignerFactory(factory);

    try {
      await authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      );
    } finally {
      unregister();
    }

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    expect(requestCall.headers?.["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(requestCall.headers?.["X-Apple-ActionSignature"]).toBe("AQID");
    expect(new TextDecoder().decode(sign.mock.calls[0][0])).toBe(
      requestCall.body,
    );
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ version: 200 }),
      new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
