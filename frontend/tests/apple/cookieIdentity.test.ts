import { describe, expect, it } from "vitest";
import { mergeCookies } from "../../src/apple/cookies";
import type { Cookie } from "../../src/types";

function cookie(overrides: Partial<Cookie>): Cookie {
  return {
    name: "token",
    value: "value",
    domain: "buy.itunes.apple.com",
    path: "/",
    httpOnly: false,
    secure: false,
    ...overrides,
  };
}

describe("Cookie replacement identity", () => {
  it("replaces a domain cookie with a host-only cookie at the same name/domain/path", () => {
    const result = mergeCookies(
      [cookie({ value: "domain" })],
      [cookie({ value: "host", hostOnly: true })],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ value: "host", hostOnly: true });
  });

  it("replaces a host-only cookie with a domain cookie at the same name/domain/path", () => {
    const result = mergeCookies(
      [cookie({ value: "host", hostOnly: true })],
      [cookie({ value: "domain" })],
    );
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("domain");
    expect(result[0].hostOnly).toBeUndefined();
  });

  it("deletes a domain cookie with an expired host-only cookie", () => {
    const result = mergeCookies(
      [cookie({ value: "domain" })],
      [cookie({ value: "", hostOnly: true, expiresAt: 1 })],
    );
    expect(result).toEqual([]);
  });

  it("deletes a host-only cookie with an expired domain cookie", () => {
    const result = mergeCookies(
      [cookie({ value: "host", hostOnly: true })],
      [cookie({ value: "", expiresAt: 1 })],
    );
    expect(result).toEqual([]);
  });

  it("canonicalizes domain spelling and never duplicates the same name/domain/path", () => {
    const result = mergeCookies(
      [cookie({ value: "old", domain: ".BUY.ITUNES.APPLE.COM", hostOnly: true })],
      [cookie({ value: "new", domain: "buy.itunes.apple.com" })],
    );
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("new");
  });
});
