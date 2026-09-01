/**
 * Public compatibility façade for the versioned skill-architecture contracts.
 *
 * Domain implementations live in focused modules. Existing callers can keep
 * importing `./architecture.js` (or the package root) while the module seams
 * remain explicit for maintainers and future extensions.
 */
export * from "./architecture-contracts.js";
export {
  validateArchitectureSpec,
  assertValidArchitectureSpec,
  normalizeArchitectureSpec,
} from "./architecture-validation.js";
export * from "./architecture-canonical.js";
export * from "./architecture-factory.js";
export * from "./architecture-compiler-overlay.js";
export * from "./architecture-sync-plan.js";
export * from "./architecture-diagram.js";
