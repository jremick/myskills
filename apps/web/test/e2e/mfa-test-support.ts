import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createHmac } from "node:crypto";
import jsQR from "jsqr";

// Playwright otherwise saves an unmasked DOM snapshot on assertion failures.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

// Decode the rendered pixels with an independent implementation, not the encoder.
// Keep both the image and decoded URI in memory: either contains the TOTP secret.
export async function decodeEnrollmentQr(qr: Locator): Promise<string> {
  await expect(qr).toBeVisible();
  const pixels = await qr.evaluate(async (element) => {
    const bounds = element.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bounds.width * devicePixelRatio);
    canvas.height = Math.round(bounds.height * devicePixelRatio);
    const context = canvas.getContext("2d")!;
    const image = new Image();
    // Production CSP permits data images but deliberately excludes blob URLs.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(element))}`;
    await image.decode();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height };
  });
  const decoded = jsQR(Uint8ClampedArray.from(pixels.data), pixels.width, pixels.height);
  expect(decoded !== null, "The rendered enrollment QR must decode").toBe(true);
  return decoded!.data;
}

export function observeEnrollmentPrivacy(page: Page) {
  const requests: Array<{ url: string; body: string; type: string }> = [];
  const output: string[] = [];
  page.on("request", request => requests.push({ url: request.url(), body: request.postData() ?? "", type: request.resourceType() }));
  page.on("console", message => output.push(message.text()));
  page.on("pageerror", error => output.push(error.message));
  return async (sensitiveValues: string[]) => {
    const origin = new URL(page.url()).origin;
    const external = requests.filter(request => /^https?:/.test(request.url) && new URL(request.url).origin !== origin);
    // index.html already loads these static fonts. Do not mistake them for QR
    // generation, and still inspect their URLs/bodies for sensitive values below.
    const staticFonts = external.filter(request => {
      const url = new URL(request.url);
      return url.protocol === "https:" && (
        (request.type === "stylesheet" && url.hostname === "fonts.googleapis.com" && url.pathname === "/css2")
        || (request.type === "font" && url.hostname === "fonts.gstatic.com" && url.pathname.endsWith(".woff2"))
      );
    });
    expect(external.length - staticFonts.length, "Enrollment must not make external QR or telemetry requests").toBe(0);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    const values = sensitiveValues.flatMap(value => [value, encodeURIComponent(value)]);
    expect(requests.some(request => values.some(value => `${request.url}\n${request.body}`.includes(value))), "Enrollment secrets must not leave the page in requests").toBe(false);
    expect(output.some(message => values.some(value => message.includes(value))), "Enrollment secrets must not appear in console output or errors").toBe(false);
    expect(values.some(value => storage.includes(value)), "Enrollment secrets must not persist in browser storage").toBe(false);
    return { externalQrOrTelemetryRequests: 0, existingStaticFontRequests: staticFonts.length, secretDisclosure: false };
  };
}

export async function captureMfaEvidence(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
    maskColor: "#cbd5e1",
    mask: [page.locator(".mfa-qr"), page.locator(".mfa-secret code"), page.locator(".mfa-secret small"), page.locator(".mfa-recovery code"), page.locator('input[type="password"]'), page.getByLabel("MFA setup code", { exact: true })],
  });
}

// RFC 6238 SHA-1 / six digits / 30 seconds, independent of the API's helper.
export function enrollmentCode(uri: string): string {
  const url = new URL(uri);
  const secret = url.searchParams.get("secret")!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map(character => alphabet.indexOf(character).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
