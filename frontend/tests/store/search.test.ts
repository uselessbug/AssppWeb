import { beforeEach, describe, expect, it } from "vitest";
import { useSearch } from "../../src/hooks/useSearch";

describe("search preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    useSearch.setState({
      term: "",
      country: "",
      entity: "iPhone",
      results: [],
      loading: false,
      error: null,
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

  it("keeps search preferences when clearing the current search", () => {
    useSearch.setState({ term: "test", country: "JP", entity: "iPad" });
    useSearch.getState().clear();

    expect(useSearch.getState().term).toBe("");
    expect(useSearch.getState().country).toBe("JP");
    expect(useSearch.getState().entity).toBe("iPad");
  });
});
