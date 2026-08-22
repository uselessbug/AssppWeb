import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import enUSTranslation from "./locales/en-US.json";
import zhCNTranslation from "./locales/zh-CN.json";
import zhTWTranslation from "./locales/zh-TW.json";
import jaTranslation from "./locales/ja.json";
import koTranslation from "./locales/ko.json";
import ruTranslation from "./locales/ru.json";
import uiFixes from "./locales/uiFixes.json";
import { downloadLibraryTranslations } from "./locales/downloadLibrary";
import { toastUiTranslations } from "./locales/toastUi";

function withUiExtras<
  T extends {
    downloads: Record<string, unknown>;
    settings: {
      data: Record<string, unknown>;
    } & Record<string, unknown>;
    toast: Record<string, unknown>;
  },
  D extends Record<string, unknown>,
  U extends Record<string, unknown>,
  F extends {
    downloads: Record<string, unknown>;
    settings: { data: Record<string, unknown> };
  },
>(translation: T, downloadsExtra: D, toastExtra: U, fixes: F) {
  return {
    ...translation,
    downloads: {
      ...translation.downloads,
      ...downloadsExtra,
      ...fixes.downloads,
    },
    settings: {
      ...translation.settings,
      data: {
        ...translation.settings.data,
        ...fixes.settings.data,
      },
    },
    toast: {
      ...translation.toast,
      ...toastExtra,
    },
  };
}

const resources = {
  "en-US": {
    translation: withUiExtras(
      enUSTranslation,
      downloadLibraryTranslations["en-US"],
      toastUiTranslations["en-US"],
      uiFixes["en-US"],
    ),
  },
  "zh-CN": {
    translation: withUiExtras(
      zhCNTranslation,
      downloadLibraryTranslations["zh-CN"],
      toastUiTranslations["zh-CN"],
      uiFixes["zh-CN"],
    ),
  },
  "zh-TW": {
    translation: withUiExtras(
      zhTWTranslation,
      downloadLibraryTranslations["zh-TW"],
      toastUiTranslations["zh-TW"],
      uiFixes["zh-TW"],
    ),
  },
  ja: {
    translation: withUiExtras(
      jaTranslation,
      downloadLibraryTranslations.ja,
      toastUiTranslations.ja,
      uiFixes.ja,
    ),
  },
  ko: {
    translation: withUiExtras(
      koTranslation,
      downloadLibraryTranslations.ko,
      toastUiTranslations.ko,
      uiFixes.ko,
    ),
  },
  ru: {
    translation: withUiExtras(
      ruTranslation,
      downloadLibraryTranslations.ru,
      toastUiTranslations.ru,
      uiFixes.ru,
    ),
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en-US",
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
