import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../src/store/settings";

describe("store/settings", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system" });
  });

  it("should default theme to system", () => {
    expect(useSettingsStore.getState().theme).toBe("system");
  });

  it("should update theme", () => {
    useSettingsStore.getState().setTheme("dark");
    expect(useSettingsStore.getState().theme).toBe("dark");
  });
});
