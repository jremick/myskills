import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RegistryApp } from "./App.js";
import { installAnalytics } from "./analytics.js";
import "./styles.css";

installAnalytics();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RegistryApp />
  </StrictMode>,
);
