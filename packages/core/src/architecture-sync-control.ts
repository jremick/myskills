/**
 * Compatibility façade for the framework-neutral, fixture-only architecture
 * sync control contracts. Implementations live in bounded concern modules;
 * this path remains stable for existing core, API, CLI, and MCP consumers.
 */
export * from "./architecture-sync-contracts.js";
export * from "./architecture-sync-validation.js";
export * from "./architecture-sync-digests.js";
export * from "./architecture-sync-transitions.js";
export * from "./architecture-sync-recovery.js";
