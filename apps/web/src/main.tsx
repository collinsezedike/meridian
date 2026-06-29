import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { initialiseI18n } from "./i18n";

void initialiseI18n()
.catch(() => {
  console.error("Failed to initialise i18n");
})
.then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
