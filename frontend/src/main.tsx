import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { installExperimentalBrowserSapRuntime } from "./apple/sap/unicornRuntime";
import "./index.css";

import "./i18n";

installExperimentalBrowserSapRuntime();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
