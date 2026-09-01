import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "./client";
import { lookupApp, parseSearchInput, searchApps } from "./search";

vi.mock("./client", () => ({
  apiGet: vi.fn(),
}));

describe("parseSearchInput", () => {
  it.each([
    ["https://apps.apple.com/us/app/example/id123456", "123456"],
    ["https://apps.apple.com/us/app/example/id123456?mt=8", "123456"],
    ["id123456", "123456"],
    ["ID123456", "123456"],
    ["123456", "123456"],
    ["  id123456  ", "123456"],
  ])("recognizes App Store IDs from %s", (input, expected) => {
    expect(parseSearchInput(input)).toEqual({
      type: "appStoreId",
      value: expected,
    });
  });

  it("recognizes a bundle ID", () => {
    expect(parseSearchInput("com.example.app")).toEqual({
      type: "bundleId",
      value: "com.example.app",
    });
  });

  it.each([
    ["example app", "example app"],
    ["  example app  ", "example app"],
    ["", ""],
    ["https://example.com/app/id123", "https://example.com/app/id123"],
    ["https://apps.apple.com/not-an-app", "https://apps.apple.com/not-an-app"],
    ["https://%", "https://%"],
  ])("keeps %s as a keyword", (input, expected) => {
    expect(parseSearchInput(input)).toEqual({ type: "term", value: expected });
  });
});

describe("search API routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiGet).mockResolvedValue(null);
  });

  it("uses lookup id for App Store IDs", async () => {
    await searchApps("https://apps.apple.com/us/app/example/id123456", "US", "iPhone", 10);
    expect(apiGet).toHaveBeenCalledWith("/api/lookup?country=US&id=123456");
  });

  it("uses lookup bundleId for bundle IDs", async () => {
    await lookupApp("com.example.app", "HK");
    expect(apiGet).toHaveBeenCalledWith(
      "/api/lookup?country=HK&bundleId=com.example.app",
    );
  });

  it("preserves country, iPhone entity and limit for keyword search", async () => {
    vi.mocked(apiGet).mockResolvedValue([]);
    await searchApps(" example app ", "JP", "iPhone", 17);
    expect(apiGet).toHaveBeenCalledWith(
      "/api/search?term=example+app&country=JP&entity=software&limit=17",
    );
  });

  it("preserves iPad entity for keyword search", async () => {
    vi.mocked(apiGet).mockResolvedValue([]);
    await searchApps("example", "US", "iPad", 25);
    expect(apiGet).toHaveBeenCalledWith(
      "/api/search?term=example&country=US&entity=iPadSoftware&limit=25",
    );
  });
});
