import { useTranslation } from "react-i18next";

const OPTIONS = [
  { lng: "pt-BR", label: "PT-BR" },
  { lng: "en-US", label: "EN-US" },
  { lng: "es-MX", label: "ES-MX" },
] as const;

export function LanguageMenu() {
  const { i18n, t } = useTranslation();

  return (
    <div className="lang-menu">
      <select
        className="lang-select"
        value={i18n.resolvedLanguage ?? i18n.language}
        onChange={(e) => {
          void i18n.changeLanguage(e.target.value);
        }}
        aria-label={t("language.selector")}
      >
        {OPTIONS.map(({ lng, label }) => (
          <option key={lng} value={lng}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
