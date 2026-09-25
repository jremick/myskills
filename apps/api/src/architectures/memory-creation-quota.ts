import { AppError } from "@myskills-app/core";
import { MAX_ARCHITECTURES_PER_OWNER } from "./service.js";

/** Shared by canonical memory architectures and their derived-shell journal. */
export class MemoryArchitectureCreationQuota {
  private readonly owners = new Map<string, Set<string>>();

  /** Call synchronously at the commit point, after every fallible async hook. */
  claim(owner: { type: "user" | "team"; id: string }, architectureId: string): void {
    const key = JSON.stringify([owner.type, owner.id]);
    const ids = this.owners.get(key) ?? new Set<string>();
    if (ids.has(architectureId)) return;
    if (ids.size >= MAX_ARCHITECTURES_PER_OWNER) {
      throw new AppError(`An owner may create at most ${MAX_ARCHITECTURES_PER_OWNER} architectures.`, "ARCHITECTURE_QUOTA_EXCEEDED", 409);
    }
    ids.add(architectureId);
    this.owners.set(key, ids);
  }
}

export function memoryCreationQuota(store: unknown): MemoryArchitectureCreationQuota {
  if (store && typeof store === "object" && "creationQuota" in store && store.creationQuota instanceof MemoryArchitectureCreationQuota) return store.creationQuota;
  throw new Error("Memory pattern migrations require the canonical memory architecture creation quota.");
}
