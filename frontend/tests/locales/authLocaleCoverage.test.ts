import { describe, expect, it } from "vitest";
import { authErrorTranslations } from "../../src/locales/authErrors";
import { toastUiTranslations } from "../../src/locales/toastUi";
import uiFixes from "../../src/locales/uiFixes.json";

const locales = ["en-US", "zh-CN", "zh-TW", "ja", "ko", "ru"] as const;
const authKeys = [
  "sapVerificationRequired",
  "sapAuthenticationFailed",
  "sapInvalidRequest",
  "sapHelperNotFound",
  "sapHelperTimeout",
  "sapHelperInvalidResponse",
  "sapHelperBusy",
  "sapAccessProtectionRequired",
  "sapHelperFailed",
] as const;

describe("authentication locale coverage", () => {
  it("defines the fresh-session retry message for all six locales", () => {
    expect(Object.keys(toastUiTranslations).sort()).toEqual([...locales].sort());
    for (const translation of Object.values(toastUiTranslations)) {
      expect(translation.reauthRetrying).toBeTruthy();
    }
  });

  it("defines all SAP authentication failure messages for all six locales", () => {
    expect(Object.keys(authErrorTranslations).sort()).toEqual([...locales].sort());
    for (const locale of locales) {
      for (const key of authKeys) {
        expect(authErrorTranslations[locale][key]).toBeTruthy();
      }
    }
  });

  it("defines Apple ID and smart search copy for all six locales", () => {
    for (const locale of locales) {
      expect(uiFixes[locale].accounts.addForm.email).toBeTruthy();
      expect(uiFixes[locale].accounts.addForm.emailPlaceholder).toBeTruthy();
      expect(uiFixes[locale].accounts.detail.email).toBeTruthy();
      expect(uiFixes[locale].search.placeholder).toContain("App ID");
      expect(uiFixes[locale].search.placeholder).toContain("Bundle ID");
      expect(uiFixes[locale].search.emptyDesc).toContain("App ID");
      expect(uiFixes[locale].search.emptyDesc).toContain("Bundle ID");
    }
  });

  it("uses saved-session semantics for simplified and traditional Chinese retry copy", () => {
    expect(toastUiTranslations["zh-CN"].reauthRetrying).toContain("缓存会话");
    expect(toastUiTranslations["zh-TW"].reauthRetrying).toContain("已儲存的工作階段");
  });
});
