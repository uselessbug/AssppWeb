import { describe, expect, it } from "vitest";
import {
  generateDeviceId,
  normalizeDeviceId,
  storeIdToCountry,
} from "../../src/apple/config";

describe("device identifiers", () => {
  it("generates a 12-character lowercase unicast locally-administered ID", () => {
    const id = generateDeviceId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    const first = parseInt(id.slice(0, 2), 16);
    expect(first & 0x01).toBe(0);
    expect(first & 0x02).toBe(0x02);
  });

  it.each([
    ["AA:BB:CC:DD:EE:FF", "aabbccddeeff"],
    ["AA BB CC DD EE FF", "aabbccddeeff"],
    ["  AABBCCDDEEFF  ", "aabbccddeeff"],
  ])("normalizes legacy device ID %s", (input, expectedTail) => {
    const normalized = normalizeDeviceId(input);
    expect(normalized.slice(2)).toBe(expectedTail.slice(2));
    const first = parseInt(normalized.slice(0, 2), 16);
    expect(first & 0x01).toBe(0);
    expect(first & 0x02).toBe(0x02);
  });

  it("does not disguise malformed values as valid IDs", () => {
    expect(normalizeDeviceId("not-a-device-id")).not.toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("storefront normalization", () => {
  it("maps a plain storefront", () => {
    expect(storeIdToCountry("143463")).toBe("HK");
  });

  it("maps a descriptor storefront", () => {
    expect(storeIdToCountry("143463-2,34")).toBe("HK");
  });

  it.each(["999999", "", "143463garbage", "-143463-2,34"])(
    "does not map unknown or malformed storefront %s",
    (value) => {
      expect(storeIdToCountry(value)).toBeUndefined();
    },
  );
});
