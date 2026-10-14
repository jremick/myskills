// The API validates signatures, SVG structure and byte budgets. These helpers
// only select the JSON representation and safe browser display behavior.
export const isPackageImage = (path: string): boolean => /\.(png|jpe?g|webp|svg)$/i.test(path);
export const isRasterPackageImage = (path: string): boolean => /\.(png|jpe?g|webp)$/i.test(path);

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
