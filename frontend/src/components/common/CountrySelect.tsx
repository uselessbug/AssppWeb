import { useTranslation } from "react-i18next";

export default function CountrySelect({
  value,
  onChange,
  availableCountryCodes,
  allCountryCodes,
  disabled,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  availableCountryCodes: string[];
  allCountryCodes: string[];
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={t("regions.all")}
      className={`rounded-xl border-0 bg-gray-100 px-3.5 py-2.5 text-base text-gray-900 outline-none transition-colors focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 dark:bg-gray-800 dark:text-white dark:disabled:bg-gray-800 dark:disabled:text-gray-500 ${className}`}
      disabled={disabled}
    >
      {availableCountryCodes.length > 0 && (
        <optgroup label={t("regions.available")}>
          {availableCountryCodes.map((c) => (
            <option key={`avail-${c}`} value={c}>
              {t(`countries.${c}`, c)} ({c})
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label={t("regions.all")}>
        {allCountryCodes.map((c) => (
          <option key={`all-${c}`} value={c}>
            {t(`countries.${c}`, c)} ({c})
          </option>
        ))}
      </optgroup>
    </select>
  );
}
