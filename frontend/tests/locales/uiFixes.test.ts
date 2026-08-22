import { describe, expect, it } from "vitest";
import uiFixes from "../../src/locales/uiFixes.json";

describe("UI locale fixes", () => {
  it("provides the missing UI strings for every supported language", () => {
    for (const fixes of Object.values(uiFixes)) {
      expect(fixes.downloads.checkUpdatesNone).toBeTruthy();
      expect(fixes.settings.data.exportFailed).toBeTruthy();
    }
  });
});
