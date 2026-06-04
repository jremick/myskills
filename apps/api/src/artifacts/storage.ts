import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ArtifactObjectStorage {
  putObject(input: {
    key: string;
    body: string;
    contentType: string;
    sha256: string;
  }): Promise<void>;
  getObject(key: string): Promise<ArtifactObject>;
}

export interface ArtifactObject {
  body: string;
  contentType: string;
  sha256?: string;
}

export class MemoryArtifactObjectStorage implements ArtifactObjectStorage {
  private objects = new Map<string, { body: string; contentType: string; sha256: string }>();

  async putObject(input: { key: string; body: string; contentType: string; sha256: string }): Promise<void> {
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
}

export class S3ArtifactObjectStorage implements ArtifactObjectStorage {
  constructor(
    private readonly options: {
      bucket: string;
      client: Pick<S3Client, "send">;
    },
  ) {}

  async putObject(input: { key: string; body: string; contentType: string; sha256: string }): Promise<void> {
    await this.options.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: Buffer.byteLength(input.body),
      Metadata: {
        sha256: input.sha256,
      },
    }));
  }

  async getObject(key: string): Promise<ArtifactObject> {
    const response = await this.options.client.send(new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
    }));
    if (!response.Body) {
      throw new Error("Artifact object body is empty.");
    }
    if (!response.ContentType) {
      throw new Error("Artifact object content type is empty.");
    }
    return {
      body: await response.Body.transformToString(),
      contentType: response.ContentType,
      sha256: response.Metadata?.sha256,
    };
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
