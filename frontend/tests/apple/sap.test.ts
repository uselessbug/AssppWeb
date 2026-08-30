import { describe, expect, it, vi } from "vitest";
import {
  createAppleActionSignature,
  createBrowserSapSigner,
  normalizeSapDeviceId,
  registerBrowserSapSignerFactory,
} from "../../src/apple/sap";

describe("apple/sap", () => {
  it("normalizes a hardware identifier to local unicast form", () => {
    expect(normalizeSapDeviceId("01:11:22:33:44:55")).toBe("021122334455");
    expect(normalizeSapDeviceId("AA-BB-CC-DD-EE-FF")).toBe("aabbccddeeff");
  });

  it("passes hardware bytes to the registered browser signer factory", async () => {
    const signer = {
      sign: vi.fn(async () => new Uint8Array([1])),
      close: vi.fn(async () => undefined),
    };
    const factory = vi.fn(async () => signer);
    const unregister = registerBrowserSapSignerFactory(factory);

    try {
      await expect(
        createBrowserSapSigner(
          {
            setupURL: "https://example.apple.com/setup",
            certificateURL: "https://example.apple.com/cert",
            version: 200,
          },
          "aabbccddeeff",
        ),
      ).resolves.toBe(signer);

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({ version: 200 }),
        new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
      );
    } finally {
      unregister();
    }
  });

  it("base64 encodes a signature over the exact request bytes", async () => {
    const sign = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const signature = await createAppleActionSignature(
      { sign, close: vi.fn(async () => undefined) },
      "<plist>secret</plist>",
    );

    expect(signature).toBe("AQID");
    expect(new TextDecoder().decode(sign.mock.calls[0][0])).toBe(
      "<plist>secret</plist>",
    );
  });

  it("rejects unsupported SAP versions before invoking the runtime", async () => {
    await expect(
      createBrowserSapSigner(
        {
          setupURL: "https://example.apple.com/setup",
          certificateURL: "https://example.apple.com/cert",
          version: 201,
        },
        "aabbccddeeff",
      ),
    ).rejects.toThrow("Unsupported SAP version 201");
  });
});
