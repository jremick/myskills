import { createContext, useContext } from "react";
import { DEFAULT_BRANDING, type BrandSettings } from "@myskills-app/core";

export const BrandingContext = createContext<{ branding: BrandSettings; saveBranding: (branding: BrandSettings) => void }>({
  branding: DEFAULT_BRANDING,
  saveBranding: () => undefined,
});

export function useBranding() { return useContext(BrandingContext); }
