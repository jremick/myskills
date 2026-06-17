const DEFAULT_PLAUSIBLE_SCRIPT_URL = "https://plausible.io/js/script.js";

export function installAnalytics(): void {
  const domain = import.meta.env.VITE_ANALYTICS_DOMAIN?.trim();
  if (!import.meta.env.PROD || !domain || typeof document === "undefined") {
    return;
  }
  const script = document.createElement("script");
  script.defer = true;
  script.dataset.domain = domain;
  script.src = import.meta.env.VITE_ANALYTICS_SCRIPT_URL?.trim() || DEFAULT_PLAUSIBLE_SCRIPT_URL;
  document.head.append(script);
}
