import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import enUSTranslation from "./locales/en-US.json";
import zhCNTranslation from "./locales/zh-CN.json";
import zhTWTranslation from "./locales/zh-TW.json";
import jaTranslation from "./locales/ja.json";
import koTranslation from "./locales/ko.json";
import ruTranslation from "./locales/ru.json";
import { downloadLibraryTranslations } from "./locales/downloadLibrary";

function withDownloadLibrary<
  T extends { downloads: Record<string, unknown> },
  E extends Record<string, unknown>,
>(translation: T, extra: E) {
  return {
    ...translation,
    downloads: {
      ...translation.downloads,
      ...extra,
    },
  };
}

const resources = {
  "en-US": {
    translation: withDownloadLibrary(
      enUSTranslation,
      downloadLibraryTranslations["en-US"],
    ),
  },
  "zh-CN": {
    translation: withDownloadLibrary(
      zhCNTranslation,
      downloadLibraryTranslations["zh-CN"],
    ),
  },
  "zh-TW": {
    translation: withDownloadLibrary(
      zhTWTranslation,
      downloadLibraryTranslations["zh-TW"],
    ),
  },
  ja: {
    translation: withDownloadLibrary(
      jaTranslation,
      downloadLibraryTranslations.ja,
    ),
  },
  ko: {
    translation: withDownloadLibrary(
      koTranslation,
      downloadLibraryTranslations.ko,
    ),
  },
  ru: {
    translation: withDownloadLibrary(
      ruTranslation,
      downloadLibraryTranslations.ru,
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
