import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../src/store/settings";

describe("store/settings", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      defaultCountry: "US",
      defaultEntity: "iPhone",
      theme: "system",
    });
  });

  it("should have default country US", () => {
    const state = useSettingsStore.getState();
    expect(state.defaultCountry).toBe("US");
  });

  it("should have default entity iPhone", () => {
    const state = useSettingsStore.getState();
    expect(state.defaultEntity).toBe("iPhone");
  });

  it("should default theme to system", () => {
    const state = useSettingsStore.getState();
    expect(state.theme).toBe("system");
  });

  it("should update default country and keep the legacy setting in sync", () => {
    useSettingsStore.getState().setDefaultCountry("GB");
    expect(useSettingsStore.getState().defaultCountry).toBe("GB");
    expect(localStorage.getItem("asspp-default-country")).toBe("GB");
  });

  it("should update default entity and keep the legacy setting in sync", () => {
    useSettingsStore.getState().setDefaultEntity("iPad");
    expect(useSettingsStore.getState().defaultEntity).toBe("iPad");
    expect(localStorage.getItem("asspp-default-entity")).toBe("iPadSoftware");
  });
});
