import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../messages/en.json";
import fr from "../messages/fr.json";

function getBrowserLanguage(){
    return(
        localStorage.getItem("language")?? (navigator.language.startsWith("fr") ? "fr" : "en")
    );
}

export function initialiseI18n() {
    return i18n.use(initReactI18next).init({
        resources: {
            en: { translation: en },
            fr: { translation: fr },
        },
        fallbackLng: "en",
        lng: getBrowserLanguage(),
        interpolation: {
            escapeValue: false,
        },
    });
}

export default i18n;