import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchApps } from "../../src/api/search";
import { useSearch } from "../../src/hooks/useSearch";

vi.mock("../../src/api/search", () => ({
  searchApps: vi.fn(),
  lookupApp: vi.fn(),
}));

describe("search preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchApps).mockResolvedValue([]);
    localStorage.clear();
    useSearch.setState({
      term: "",
      country: "",
      entity: "iPhone",
      results: [],
      loading: false,
      error: null,
      hasSearched: false,
    });
  });

  it("initializes the country once from the account fallback", () => {
    useSearch.getState().initializeCountry("JP");
    expect(useSearch.getState().country).toBe("JP");
    expect(localStorage.getItem("asspp-search-country")).toBe("JP");

    useSearch.getState().initializeCountry("GB");
    expect(useSearch.getState().country).toBe("JP");
  });

  it("falls back to US when no valid account country is available", () => {
    useSearch.getState().initializeCountry("");
    expect(useSearch.getState().country).toBe("US");
  });

  it("persists country and device selections", () => {
    useSearch.getState().setSearchParam({ country: "GB", entity: "iPad" });

    expect(useSearch.getState().country).toBe("GB");
    expect(useSearch.getState().entity).toBe("iPad");
    expect(localStorage.getItem("asspp-search-country")).toBe("GB");
    expect(localStorage.getItem("asspp-search-entity")).toBe("iPad");
  });

  it("distinguishes the initial state from a completed empty search", async () => {
    expect(useSearch.getState().hasSearched).toBe(false);

    await useSearch.getState().search("missing", "US", "iPhone");

    expect(searchApps).toHaveBeenCalledWith("missing", "US", "iPhone");
    expect(useSearch.getState().results).toEqual([]);
    expect(useSearch.getState().hasSearched).toBe(true);
  });

  it("keeps search preferences when clearing the current search", () => {
    useSearch.setState({
      term: "test",
      country: "JP",
      entity: "iPad",
      hasSearched: true,
    });
    useSearch.getState().clear();

    expect(useSearch.getState().term).toBe("");
    expect(useSearch.getState().country).toBe("JP");
    expect(useSearch.getState().entity).toBe("iPad");
    expect(useSearch.getState().hasSearched).toBe(false);
  });
});
