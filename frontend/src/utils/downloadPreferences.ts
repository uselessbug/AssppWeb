import { countryCodeMap } from "../apple/config";

const DOWNLOAD_COUNTRY_KEY = "asspp-download-country";

export function readDownloadCountry(): string {
  if (typeof localStorage === "undefined") return "";
  const country = localStorage.getItem(DOWNLOAD_COUNTRY_KEY)?.trim().toUpperCase() ?? "";
  return country in countryCodeMap ? country : "";
}

export function writeDownloadCountry(country: string) {
  if (typeof localStorage === "undefined") return;
  const normalized = country.trim().toUpperCase();
  if (normalized in countryCodeMap) {
    localStorage.setItem(DOWNLOAD_COUNTRY_KEY, normalized);
  }
}
