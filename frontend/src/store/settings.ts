import { create } from "zustand";
import { persist } from "zustand/middleware";

type ThemeType = "light" | "dark" | "system";

interface SettingsState {
  theme: ThemeType;
  setTheme: (theme: ThemeType) => void;
}

function isTheme(value: unknown): value is ThemeType {
  return value === "light" || value === "dark" || value === "system";
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "asspp-settings",
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<SettingsState>;
        return {
          ...currentState,
          theme: isTheme(persisted.theme) ? persisted.theme : currentState.theme,
        };
      },
    },
  ),
);
