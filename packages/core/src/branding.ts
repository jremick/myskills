export interface BrandSettings {
  text: string;
  showText: boolean;
  logoDataUrl: string | null;
}

export const DEFAULT_BRANDING: Readonly<BrandSettings> = Object.freeze({
  text: "MySkills",
  showText: true,
  logoDataUrl: null,
});

export const MAX_BRAND_TEXT_LENGTH = 80;
export const MAX_BRAND_LOGO_BYTES = 256 * 1024;
