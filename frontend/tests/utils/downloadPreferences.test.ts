import { beforeEach, describe, expect, it } from "vitest";
import {
  readDownloadCountry,
  writeDownloadCountry,
} from "../../src/utils/downloadPreferences";

describe("download preferences", () => {
  beforeEach(() => localStorage.clear());

  it("persists valid country selections", () => {
    writeDownloadCountry("jp");
    expect(readDownloadCountry()).toBe("JP");
    expect(localStorage.getItem("asspp-download-country")).toBe("JP");
  });

  it("ignores invalid stored countries", () => {
    localStorage.setItem("asspp-download-country", "invalid");
    expect(readDownloadCountry()).toBe("");
  });
});
