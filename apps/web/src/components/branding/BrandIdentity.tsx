import { useState } from "react";
import { DEFAULT_BRANDING, type BrandSettings } from "@myskills-app/core";
import { useBranding } from "./branding-context.js";

export function BrandIdentity({ value, horizontal = false }: { value?: BrandSettings; horizontal?: boolean }) {
  const { branding } = useBranding();
  const current = value ?? branding;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const customLogo = current.logoDataUrl && current.logoDataUrl !== failedImage ? current.logoDataUrl : null;
  const originalWordmark = horizontal && !customLogo && current.text === DEFAULT_BRANDING.text && current.showText;
  return <span className="brand-identity" role="img" aria-label={current.text} title={current.text} data-text-hidden={!current.showText}>
    <img className={originalWordmark ? "brand-original-wordmark" : "brand-logo"}
      src={customLogo ?? (originalWordmark ? "/brand/myskills-logo-horizontal.svg" : "/brand/myskills-mark.svg")}
      alt="" width={originalWordmark ? 360 : 100} height={originalWordmark ? 110 : 100}
      onError={customLogo ? () => setFailedImage(customLogo) : undefined} />
    {current.showText && !originalWordmark && <span className="brand-text">{current.text}</span>}
  </span>;
}
