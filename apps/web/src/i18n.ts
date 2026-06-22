import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../messages/en.json";
import fr from "../messages/fr.json";

const browserLanguage = localStorage.getItem("language") || (navigator.language.startsWith("fr") ? "fr" : "en");

i18n.use(initReactI18next).init({
    resources: {
        en: { translation: en },
        fr: { translation: fr },
    },
    fallbackLng: "en",
    lng: browserLanguage,
    interpolation: {
        escapeValue: false,
    },
});

export default i18n;