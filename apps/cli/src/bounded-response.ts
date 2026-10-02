export const MAX_PACKAGE_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface BoundedResponse {
  headers?: Headers | Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** Read bytes before decoding or hashing. The deadline covers body stalls. */
export async function readBoundedResponse(response: BoundedResponse, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PACKAGE_RESPONSE_BYTES) throw new Error("Invalid response byte limit.");
  const headers = response.headers instanceof Headers ? response.headers : new Headers(response.headers);
  const length = headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch(() => {});
    throw new Error("API response exceeds its byte limit.");
  }
  // Older injected test transports expose text only. Native fetch always
  // exposes body; its production path is bounded before any allocation.
  if (response.body === undefined) {
    const bytes = Buffer.from(await response.text());
    if (bytes.length > maxBytes) throw new Error("API response exceeds its byte limit.");
    return bytes;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { rejectAbort(new Error("API response timed out.")); void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("API response timed out.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new Error("API response timed out.");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("API response exceeds its byte limit.");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function decodeResponseUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("API response is not valid UTF-8."); }
}
