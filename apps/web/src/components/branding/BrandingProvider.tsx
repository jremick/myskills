import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_BRANDING, type BrandSettings } from "@myskills-app/core";
import type { RegistryClient } from "../../api.js";
import { BrandingContext } from "./branding-context.js";

export function BrandingProvider({ client, children }: { client: RegistryClient; children: ReactNode }) {
  const [branding, setBranding] = useState<BrandSettings>(DEFAULT_BRANDING);
  const epoch = useRef(0);
  const saveBranding = useCallback((next: BrandSettings) => {
    epoch.current += 1;
    setBranding(next);
  }, []);
  useEffect(() => {
    const request = ++epoch.current;
    setBranding(DEFAULT_BRANDING);
    client.getBranding().then((next) => {
      if (request === epoch.current) setBranding(next);
    }).catch(() => { /* Keep navigation and sign-in usable when branding is unavailable. */ });
    return () => { epoch.current += 1; };
  }, [client]);
  useEffect(() => {
    const originalTitle = document.title;
    document.title = branding.text === DEFAULT_BRANDING.text ? originalTitle : branding.text;
    return () => { document.title = originalTitle; };
  }, [branding.text]);
  useEffect(() => {
    if (!branding.logoDataUrl) return;
    const originalIcons = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = branding.logoDataUrl.slice(5, branding.logoDataUrl.indexOf(";"));
    icon.href = branding.logoDataUrl;
    const image = new Image();
    image.src = branding.logoDataUrl;
    let cancelled = false;
    image.decode().then(() => {
      if (cancelled) return;
      // Remove competing defaults so the browser uses the saved logo.
      originalIcons.forEach(original => original.remove());
      document.head.append(icon);
    }).catch(() => { /* Keep the default icons if this browser cannot decode the logo. */ });
    return () => {
      cancelled = true;
      if (icon.isConnected) {
        icon.remove();
        document.head.append(...originalIcons);
      }
    };
  }, [branding.logoDataUrl]);
  const value = useMemo(() => ({ branding, saveBranding }), [branding, saveBranding]);
  return <BrandingContext value={value}>{children}</BrandingContext>;
}
