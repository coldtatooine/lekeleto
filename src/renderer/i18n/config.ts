import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enUS from "./locales/en-US.json";
import esMX from "./locales/es-MX.json";
import ptBR from "./locales/pt-BR.json";

const STORAGE_KEY = "lekeleto-lang";
const SUPPORTED = ["pt-BR", "en-US", "es-MX"] as const;

function initialLanguage(): string {
  if (typeof localStorage === "undefined") return "pt-BR";
  const s = localStorage.getItem(STORAGE_KEY);
  if (s && SUPPORTED.includes(s as (typeof SUPPORTED)[number])) return s;
  return "pt-BR";
}

void i18n.use(initReactI18next).init({
  resources: {
    "pt-BR": { translation: ptBR },
    "en-US": { translation: enUS },
    "es-MX": { translation: esMX },
  },
  lng: initialLanguage(),
  fallbackLng: "pt-BR",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lng) => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, lng);
  }
});

export default i18n;
export { SUPPORTED };
