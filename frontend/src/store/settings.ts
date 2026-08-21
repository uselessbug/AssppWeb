import { create } from "zustand";
import { persist } from "zustand/middleware";

type ThemeType = "light" | "dark" | "system";
export type EntityType = "iPhone" | "iPad";

const LEGACY_COUNTRY_KEY = "asspp-default-country";
const LEGACY_ENTITY_KEY = "asspp-default-entity";

function readLegacyCountry(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(LEGACY_COUNTRY_KEY);
}

function readLegacyEntity(): EntityType | null {
  if (typeof localStorage === "undefined") return null;

  switch (localStorage.getItem(LEGACY_ENTITY_KEY)) {
    case "software":
    case "iPhone":
      return "iPhone";
    case "iPadSoftware":
    case "iPad":
      return "iPad";
    default:
      return null;
  }
}

function writeLegacyCountry(country: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LEGACY_COUNTRY_KEY, country);
}

function writeLegacyEntity(entity: EntityType) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    LEGACY_ENTITY_KEY,
    entity === "iPad" ? "iPadSoftware" : "software",
  );
}

interface SettingsState {
  defaultCountry: string;
  defaultEntity: EntityType;
  theme: ThemeType;
  setDefaultCountry: (country: string) => void;
  setDefaultEntity: (entity: EntityType) => void;
  setTheme: (theme: ThemeType) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultCountry: readLegacyCountry() ?? "US",
      defaultEntity: readLegacyEntity() ?? "iPhone",
      theme: "system",
      setDefaultCountry: (country) => {
        writeLegacyCountry(country);
        set({ defaultCountry: country });
      },
      setDefaultEntity: (entity) => {
        writeLegacyEntity(entity);
        set({ defaultEntity: entity });
      },
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "asspp-settings",
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<SettingsState>;
        return {
          ...currentState,
          ...persisted,
          defaultCountry:
            readLegacyCountry() ??
            persisted.defaultCountry ??
            currentState.defaultCountry,
          defaultEntity:
            readLegacyEntity() ??
            persisted.defaultEntity ??
            currentState.defaultEntity,
        };
      },
    },
  ),
);
