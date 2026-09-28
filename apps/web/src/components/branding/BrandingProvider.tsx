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
  const value = useMemo(() => ({ branding, saveBranding }), [branding, saveBranding]);
  return <BrandingContext value={value}>{children}</BrandingContext>;
}
