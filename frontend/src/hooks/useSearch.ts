import { create } from "zustand";
import type { Software } from "../types";
import { searchApps, lookupApp } from "../api/search";

export type SearchEntity = "iPhone" | "iPad";

const SEARCH_COUNTRY_KEY = "asspp-search-country";
const SEARCH_ENTITY_KEY = "asspp-search-entity";

function normalizeCountry(value: string | null | undefined): string {
  const country = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(country) ? country : "";
}

function normalizeEntity(value: string | null | undefined): SearchEntity {
  return value === "iPad" ? "iPad" : "iPhone";
}

function readStoredCountry(): string {
  if (typeof localStorage === "undefined") return "";
  return normalizeCountry(localStorage.getItem(SEARCH_COUNTRY_KEY));
}

function readStoredEntity(): SearchEntity {
  if (typeof localStorage === "undefined") return "iPhone";
  return normalizeEntity(localStorage.getItem(SEARCH_ENTITY_KEY));
}

function writeStoredCountry(country: string) {
  if (typeof localStorage === "undefined") return;
  const normalized = normalizeCountry(country);
  if (normalized) localStorage.setItem(SEARCH_COUNTRY_KEY, normalized);
  else localStorage.removeItem(SEARCH_COUNTRY_KEY);
}

function writeStoredEntity(entity: SearchEntity) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SEARCH_ENTITY_KEY, entity);
}

interface SearchState {
  term: string;
  country: string;
  entity: SearchEntity;
  results: Software[];
  loading: boolean;
  error: string | null;
  hasSearched: boolean;
  setSearchParam: (
    param: Partial<Pick<SearchState, "term" | "country" | "entity">>,
  ) => void;
  initializeCountry: (fallbackCountry: string) => void;
  search: (
    term: string,
    country: string,
    entity: SearchEntity,
  ) => Promise<void>;
  lookup: (bundleId: string, country: string) => Promise<void>;
  clear: () => void;
}

export const useSearch = create<SearchState>((set, get) => ({
  term: "",
  country: readStoredCountry(),
  entity: readStoredEntity(),
  results: [],
  loading: false,
  error: null,
  hasSearched: false,
  setSearchParam: (param) => {
    if (param.country !== undefined) writeStoredCountry(param.country);
    if (param.entity !== undefined) writeStoredEntity(param.entity);
    set((state) => ({ ...state, ...param }));
  },
  initializeCountry: (fallbackCountry) => {
    if (get().country) return;
    const country = normalizeCountry(fallbackCountry) || "US";
    writeStoredCountry(country);
    set({ country });
  },
  search: async (term, country, entity) => {
    writeStoredCountry(country);
    writeStoredEntity(entity);
    set({ loading: true, error: null, term, country, entity });
    try {
      const apps = await searchApps(term, country, entity);
      set({ results: apps, hasSearched: true });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Search failed",
        results: [],
        hasSearched: true,
      });
    } finally {
      set({ loading: false });
    }
  },
  lookup: async (bundleId, country) => {
    set({ loading: true, error: null });
    try {
      const app = await lookupApp(bundleId, country);
      set({ results: app ? [app] : [], hasSearched: true });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Lookup failed",
        results: [],
        hasSearched: true,
      });
    } finally {
      set({ loading: false });
    }
  },
  clear: () =>
    set({ term: "", results: [], error: null, hasSearched: false }),
}));
