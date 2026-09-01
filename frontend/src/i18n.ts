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
import { authErrorTranslations } from "./locales/authErrors";
import { downloadLibraryTranslations } from "./locales/downloadLibrary";
import { toastUiTranslations } from "./locales/toastUi";

function withUiExtras<
  T extends {
    search: Record<string, unknown>;
    accounts: {
      addForm: Record<string, unknown>;
      detail: Record<string, unknown>;
    } & Record<string, unknown>;
    downloads: Record<string, unknown>;
    errors: {
      auth: Record<string, unknown>;
    } & Record<string, unknown>;
    settings: {
      data: Record<string, unknown>;
    } & Record<string, unknown>;
    toast: Record<string, unknown>;
  },
  D extends Record<string, unknown>,
  U extends Record<string, unknown>,
  A extends Record<string, unknown>,
  F extends {
    search: Record<string, unknown>;
    accounts: {
      addForm: Record<string, unknown>;
      detail: Record<string, unknown>;
    };
    downloads: Record<string, unknown>;
    settings: { data: Record<string, unknown> };
  },
>(translation: T, downloadsExtra: D, toastExtra: U, authExtra: A, fixes: F) {
  return {
    ...translation,
    search: {
      ...translation.search,
      ...fixes.search,
    },
    accounts: {
      ...translation.accounts,
      addForm: {
        ...translation.accounts.addForm,
        ...fixes.accounts.addForm,
      },
      detail: {
        ...translation.accounts.detail,
        ...fixes.accounts.detail,
      },
    },
    downloads: {
      ...translation.downloads,
      ...downloadsExtra,
      ...fixes.downloads,
    },
    errors: {
      ...translation.errors,
      auth: {
        ...translation.errors.auth,
        ...authExtra,
      },
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
      authErrorTranslations["en-US"],
      uiFixes["en-US"],
    ),
  },
  "zh-CN": {
    translation: withUiExtras(
      zhCNTranslation,
      downloadLibraryTranslations["zh-CN"],
      toastUiTranslations["zh-CN"],
      authErrorTranslations["zh-CN"],
      uiFixes["zh-CN"],
    ),
  },
  "zh-TW": {
    translation: withUiExtras(
      zhTWTranslation,
      downloadLibraryTranslations["zh-TW"],
      toastUiTranslations["zh-TW"],
      authErrorTranslations["zh-TW"],
      uiFixes["zh-TW"],
    ),
  },
  ja: {
    translation: withUiExtras(
      jaTranslation,
      downloadLibraryTranslations.ja,
      toastUiTranslations.ja,
      authErrorTranslations.ja,
      uiFixes.ja,
    ),
  },
  ko: {
    translation: withUiExtras(
      koTranslation,
      downloadLibraryTranslations.ko,
      toastUiTranslations.ko,
      authErrorTranslations.ko,
      uiFixes.ko,
    ),
  },
  ru: {
    translation: withUiExtras(
      ruTranslation,
      downloadLibraryTranslations.ru,
      toastUiTranslations.ru,
      authErrorTranslations.ru,
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
