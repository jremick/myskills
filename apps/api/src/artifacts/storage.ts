import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";

export class ArtifactStorageTimeoutError extends Error {
  constructor() {
    super("Artifact storage request timed out.");
    this.name = "ArtifactStorageTimeoutError";
  }
}

export interface ArtifactObjectStorage {
  // Artifact keys are immutable: implementations must fail rather than overwrite an existing key.
  putObject(input: {
    key: string;
    body: string;
    contentType: string;
    sha256: string;
  }): Promise<void>;
  getObject(key: string): Promise<ArtifactObject>;
  deleteObject(key: string): Promise<void>;
  checkReady(): Promise<void>;
}

export interface ArtifactObject {
  body: string;
  contentType: string;
  sha256?: string;
}

export class MemoryArtifactObjectStorage implements ArtifactObjectStorage {
  private objects = new Map<string, { body: string; contentType: string; sha256: string }>();

  async putObject(input: { key: string; body: string; contentType: string; sha256: string }): Promise<void> {
    if (this.objects.has(input.key)) {
      throw new Error("Artifact object already exists.");
    }
    this.objects.set(input.key, {
      body: input.body,
      contentType: input.contentType,
      sha256: input.sha256,
    });
  }

  async getObject(key: string): Promise<ArtifactObject> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error("Artifact object not found.");
    }
    return {
      body: object.body,
      contentType: object.contentType,
      sha256: object.sha256,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async checkReady(): Promise<void> {}
}

export class S3ArtifactObjectStorage implements ArtifactObjectStorage {
  private readyUntil = 0;
  private readinessInFlight: Promise<void> | null = null;

  constructor(
    private readonly options: {
      bucket: string;
      client: Pick<S3Client, "send">;
      requestTimeoutMs?: number;
    },
  ) {
    if (options.requestTimeoutMs !== undefined && (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) {
      throw new Error("Artifact storage request timeout must be positive.");
    }
  }

  async putObject(input: { key: string; body: string; contentType: string; sha256: string }): Promise<void> {
    await this.withRequestTimeout((abortSignal) => this.options.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: Buffer.byteLength(input.body),
      IfNoneMatch: "*",
      Metadata: {
        sha256: input.sha256,
      },
    }), { abortSignal }));
  }

  async getObject(key: string): Promise<ArtifactObject> {
    return this.withRequestTimeout(async (abortSignal) => {
      const response = await this.options.client.send(new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
      }), { abortSignal });
      if (!response.Body) throw new Error("Artifact object body is empty.");
      if (!response.ContentType) throw new Error("Artifact object content type is empty.");
      const body = response.Body;
      if (abortSignal.aborted) {
        if ("destroy" in body && typeof body.destroy === "function") body.destroy();
        throw new ArtifactStorageTimeoutError();
      }
      // The SDK can finish its request promise before its response stream ends.
      // Bound consumption too, and release the Node stream on cancellation.
      const abortBody = () => {
        if ("destroy" in body && typeof body.destroy === "function") body.destroy(new ArtifactStorageTimeoutError());
      };
      abortSignal.addEventListener("abort", abortBody, { once: true });
      try {
        return {
          body: await body.transformToString(),
          contentType: response.ContentType,
          sha256: response.Metadata?.sha256,
        };
      } finally {
        abortSignal.removeEventListener("abort", abortBody);
      }
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.withRequestTimeout((abortSignal) => this.options.client.send(new DeleteObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
    }), { abortSignal }));
  }

  private async withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ArtifactStorageTimeoutError();
        reject(error);
        controller.abort(error);
      }, this.options.requestTimeoutMs ?? 15_000);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async checkReady(): Promise<void> {
    if (this.readyUntil > Date.now()) {
      return;
    }
    if (this.readinessInFlight) {
      return this.readinessInFlight;
    }
    this.readinessInFlight = this.performReadinessCheck();
    try {
      await this.readinessInFlight;
    } finally {
      this.readinessInFlight = null;
    }
  }

  private async performReadinessCheck(): Promise<void> {
    const body = "myskills-ready";
    const key = `.myskills-readiness/${randomUUID()}`;
    let written = false;
    try {
      // Exercise the same least-privilege object permissions used at runtime; no bucket-list permission is required.
      await this.putObject({
        key,
        body,
        contentType: "text/plain",
        sha256: createHash("sha256").update(body).digest("hex"),
      });
      written = true;
      const stored = await this.getObject(key);
      if (stored.body !== body) {
        throw new Error("Artifact readiness object did not round trip.");
      }
    } finally {
      if (written) {
        await this.deleteObject(key);
      }
    }
    this.readyUntil = Date.now() + 30_000;
  }
}

export function createArtifactObjectStorageFromEnv(env: NodeJS.ProcessEnv): ArtifactObjectStorage | undefined {
  const production = env.NODE_ENV === "production";
  const mode = normalizeStorageMode(env.ARTIFACT_STORAGE_MODE ?? (production ? "s3" : "db"));
  if (mode === "db") {
    if (production) {
      throw new Error("ARTIFACT_STORAGE_MODE=db is not allowed in production.");
    }
    return undefined;
  }

  const accessKeyId = optionalString(env.S3_ACCESS_KEY_ID);
  const secretAccessKey = optionalString(env.S3_SECRET_ACCESS_KEY);
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be provided together.");
  }

  const endpoint = optionalString(env.S3_ENDPOINT);
  validateProductionS3Endpoint({ endpoint, production, allowInsecureEndpoint: optionalBoolean(env.S3_ALLOW_INSECURE_ENDPOINT) ?? false });
  const client = new S3Client({
    region: optionalString(env.S3_REGION) ?? "us-east-1",
    endpoint,
    forcePathStyle: optionalBoolean(env.S3_FORCE_PATH_STYLE) ?? Boolean(endpoint),
    credentials: accessKeyId && secretAccessKey ? {
      accessKeyId,
      secretAccessKey,
    } : undefined,
  });

  return new S3ArtifactObjectStorage({
    bucket: requiredString(env.S3_BUCKET, "S3_BUCKET"),
    client,
  });
}

function normalizeStorageMode(mode: string): "db" | "s3" {
  if (mode === "db" || mode === "s3") {
    return mode;
  }
  throw new Error("ARTIFACT_STORAGE_MODE must be db or s3.");
}

function requiredString(value: string | undefined, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function validateProductionS3Endpoint(input: {
  endpoint: string | undefined;
  production: boolean;
  allowInsecureEndpoint: boolean;
}): void {
  if (!input.production || !input.endpoint) {
    return;
  }
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw new Error("S3_ENDPOINT must be a valid URL.");
  }
  if (url.protocol === "https:") {
    return;
  }
  if (url.protocol === "http:" && input.allowInsecureEndpoint) {
    return;
  }
  throw new Error("S3_ENDPOINT must use https in production unless S3_ALLOW_INSECURE_ENDPOINT=true is set for a trusted private network.");
}

function optionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("Boolean environment values must be true or false.");
}
