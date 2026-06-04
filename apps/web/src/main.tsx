import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RegistryApp } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RegistryApp />
  </StrictMode>,
);
