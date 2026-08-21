import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import CountrySelect from "../common/CountrySelect";
import EmptyState from "../common/EmptyState";
import Spinner from "../common/Spinner";
import { useSearch } from "../../hooks/useSearch";
import { useAccounts } from "../../hooks/useAccounts";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { firstAccountCountry } from "../../utils/account";
import { countryCodeMap, storeIdToCountry } from "../../apple/config";

export default function SearchPage() {
  const { t } = useTranslation();
  const { defaultCountry, defaultEntity } = useSettingsStore();
  const { accounts } = useAccounts();
  const initialCountry = firstAccountCountry(accounts) ?? defaultCountry;
  const addToast = useToastStore((s) => s.addToast);

  const {
    term,
    country,
    entity,
    results,
    loading,
    error,
    search,
    setSearchParam,
  } = useSearch();

  useEffect(() => {
    if (error) {
      addToast(error, "error");
    }
  }, [error, addToast]);

  useEffect(() => {
    if (!country && initialCountry) setSearchParam({ country: initialCountry });
    if (!entity && defaultEntity) setSearchParam({ entity: defaultEntity });
  }, [country, initialCountry, entity, defaultEntity, setSearchParam]);

  const activeCountry = country || initialCountry;
  const activeEntity = entity || defaultEntity;

  const availableCountryCodes = Array.from(
    new Set(
      accounts
        .map((a) => storeIdToCountry(a.store))
        .filter(Boolean) as string[],
    ),
  ).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  const allCountryCodes = Object.keys(countryCodeMap).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim()) return;
    search(term.trim(), activeCountry, activeEntity);
  }

  return (
    <PageContainer title={t("search.title")}>
      <form
        onSubmit={handleSubmit}
        className="mb-8 space-y-3 rounded-3xl bg-white p-3 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-4"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={term}
            onChange={(e) => setSearchParam({ term: e.target.value })}
            placeholder={t("search.placeholder")}
            className="min-h-11 flex-1 rounded-2xl border-0 bg-gray-100 px-4 py-2.5 text-base text-gray-900 placeholder:text-gray-500 focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-400"
          />
          <button
            type="submit"
            disabled={loading || !term.trim()}
            aria-busy={loading}
            className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && <Spinner />}
            {loading ? t("search.searching") : t("search.button")}
          </button>
        </div>
        <div className="flex w-full gap-3 overflow-hidden border-t border-gray-100 pt-3 dark:border-gray-800">
          <CountrySelect
            value={activeCountry}
            onChange={(c) => setSearchParam({ country: c })}
            availableCountryCodes={availableCountryCodes}
            allCountryCodes={allCountryCodes}
            className="w-1/2 truncate border-0 bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white"
          />
          <select
            value={activeEntity}
            onChange={(e) => setSearchParam({ entity: e.target.value })}
            aria-label={t("settings.defaults.entity")}
            className="min-h-11 w-1/2 truncate rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-800 dark:text-white"
          >
            <option value="iPhone">iPhone</option>
            <option value="iPad">iPad</option>
          </select>
        </div>
      </form>

      {results.length === 0 && !loading && !error && (
        <EmptyState
          icon={
            <svg
              className="h-8 w-8 text-blue-600 dark:text-blue-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
          }
          title={t("search.empty")}
          description={t("search.emptyDesc")}
        />
      )}

      {results.length > 0 && (
        <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {results.map((app) => (
              <Link
                key={app.id}
                to={`/search/${app.id}`}
                state={{ app, country: activeCountry }}
                className="flex items-center gap-4 p-4 transition-colors hover:bg-gray-50 active:bg-gray-100 dark:hover:bg-gray-800/70 dark:active:bg-gray-800"
              >
                <AppIcon url={app.artworkUrl} name={app.name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-gray-900 dark:text-white">
                    {app.name}
                  </p>
                  <p className="truncate text-sm text-gray-500 dark:text-gray-400">
                    {app.artistName}
                  </p>
                  <div className="mt-1 flex items-center gap-2 overflow-hidden text-xs text-gray-400 dark:text-gray-500">
                    <span className="shrink-0">
                      {app.formattedPrice ?? t("search.free")}
                    </span>
                    <span className="truncate">{app.primaryGenreName}</span>
                    <span className="shrink-0">
                      ★ {app.averageUserRating.toFixed(1)}
                    </span>
                  </div>
                </div>
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xl text-blue-600 dark:bg-gray-800 dark:text-blue-400"
                  aria-hidden="true"
                >
                  ›
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
