import { createHash } from "node:crypto";
import { AppError } from "@myskills-app/core";
import type { ArtifactObjectStorage } from "./storage.js";
import type { ArtifactPayload } from "../submissions/types.js";

export interface ArtifactPayloadRecord {
  storageKey: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  payload: unknown;
}

export async function readArtifactPayload(input: {
  artifactStorage?: ArtifactObjectStorage;
  artifact: ArtifactPayloadRecord;
}): Promise<ArtifactPayload> {
  if (!input.artifactStorage) {
    return parseArtifactPayload(input.artifact.payload);
  }

  let object: { body: string; contentType: string; sha256?: string };
  try {
    object = await input.artifactStorage.getObject(input.artifact.storageKey);
  } catch (error) {
    if (!hasDbArtifactPayload(input.artifact.payload)) {
      throw new AppError("Artifact payload is unavailable.", "ARTIFACT_PAYLOAD_UNAVAILABLE", 500);
    }
    assertArtifactBodyMatchesMetadata(JSON.stringify(input.artifact.payload), input.artifact);
    return parseArtifactPayload(input.artifact.payload);
  }

  assertArtifactObjectMatchesMetadata(object, input.artifact);
  try {
    return parseArtifactPayload(JSON.parse(object.body));
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(error instanceof Error ? error.message : "Invalid artifact payload.", "INVALID_PACKAGE_PAYLOAD", 500);
  }
}

export function parseArtifactPayload(input: unknown): ArtifactPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid artifact payload.");
  }
  const files = (input as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new Error("Invalid artifact payload files.");
  }
  return {
    files: files.map((file) => {
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        throw new Error("Invalid artifact payload file.");
      }
      const record = file as Record<string, unknown>;
      if (typeof record.path !== "string" || typeof record.content !== "string") {
        throw new Error("Invalid artifact payload file.");
      }
      return {
        path: record.path,
        content: record.content,
      };
    }),
  };
}

export function assertArtifactBodyMatchesMetadata(body: string, artifact: {
  sha256: string;
  byteSize: number;
}): void {
  const byteSize = Buffer.byteLength(body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (byteSize !== artifact.byteSize || sha256 !== artifact.sha256) {
    throw new AppError("Artifact payload does not match stored metadata.", "ARTIFACT_METADATA_MISMATCH", 500);
  }
}

function hasDbArtifactPayload(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const files = (input as { files?: unknown }).files;
  return Array.isArray(files) && files.length > 0;
}

function assertArtifactObjectMatchesMetadata(object: {
  body: string;
  contentType: string;
  sha256?: string;
}, artifact: {
  sha256: string;
  byteSize: number;
  contentType: string;
}): void {
  if (object.contentType !== artifact.contentType || (object.sha256 && object.sha256 !== artifact.sha256)) {
    throw new AppError("Artifact object metadata does not match stored metadata.", "ARTIFACT_METADATA_MISMATCH", 500);
  }
  assertArtifactBodyMatchesMetadata(object.body, artifact);
}
