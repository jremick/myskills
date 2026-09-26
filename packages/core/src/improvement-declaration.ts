import {
  arrayField,
  enumValue,
  fail,
  identifier,
  improvementDigest,
  objectInput,
  safeText,
  schemaVersionOne,
  sha256Field,
  uniqueEnumArray,
  uniqueIdentifierArray,
} from "./improvement-shared.js";

export const optimizationDeclarationIntents = ["unspecified", "portable", "targeted"] as const;
export const improvementObjectives = [
  "task-success",
  "activation-accuracy",
  "output-quality",
  "safety",
  "latency",
  "token-efficiency",
  "cost",
  "domain-quality",
] as const;
export const improvementOperatingSystems = ["linux", "macos", "windows"] as const;
export const improvementNetworkModes = ["required", "optional", "none"] as const;

export type OptimizationDeclarationIntent = (typeof optimizationDeclarationIntents)[number];
export type ImprovementObjective = (typeof improvementObjectives)[number];
export type ImprovementOperatingSystem = (typeof improvementOperatingSystems)[number];
export type ImprovementNetworkMode = (typeof improvementNetworkModes)[number];

export interface ImprovementModelRefV1 {
  provider: string;
  id: string;
}

export interface OptimizationAppRefV1 {
  id: string;
  version?: string;
}

export interface OptimizationEnvironmentV1 {
  os?: ImprovementOperatingSystem[];
  requiredCapabilities?: string[];
  network?: ImprovementNetworkMode;
}

/** One tuple constraint. Dimensions apply together; entries within a dimension are alternatives. */
export interface OptimizationTargetV1 {
  id: string;
  models?: ImprovementModelRefV1[];
  apps?: OptimizationAppRefV1[];
  environment?: OptimizationEnvironmentV1;
}

export interface OptimizationDeclarationV1 {
  schemaVersion: 1;
  intent: OptimizationDeclarationIntent;
  targets: OptimizationTargetV1[];
  objectives: ImprovementObjective[];
  limitations: string[];
}

export const unspecifiedOptimizationDeclarationV1: Readonly<OptimizationDeclarationV1> = Object.freeze({
  schemaVersion: 1,
  intent: "unspecified",
  targets: [],
  objectives: [],
  limitations: [],
});

const MAX_TARGETS = 16;
const MAX_DIMENSION_ENTRIES = 16;
const MAX_CAPABILITIES = 32;
const MAX_OBJECTIVES = 8;
const MAX_LIMITATION_CHARACTERS = 2_000;

export function normalizeOptimizationDeclarationV1(input: unknown): OptimizationDeclarationV1 {
  const record = objectInput(input, "declaration", ["schemaVersion", "intent", "targets", "objectives", "limitations"]);
  schemaVersionOne(record.schemaVersion, "declaration");
  const intent = enumValue(record.intent, "declaration intent", optimizationDeclarationIntents);
  const targets = arrayField(record.targets ?? [], "declaration targets", MAX_TARGETS).map((target, index) => normalizeTarget(target, index));
  if (new Set(targets.map((target) => target.id)).size !== targets.length) fail("declaration target ids must be unique.");
  if (intent === "targeted" && targets.length === 0) fail("A targeted declaration requires at least one target.");
  if (intent === "unspecified" && targets.length > 0) fail("An unspecified declaration cannot list targets.");
  const objectives = uniqueEnumArray(record.objectives ?? [], "declaration objectives", improvementObjectives, MAX_OBJECTIVES, { sort: false });
  const limitations = arrayField(record.limitations ?? [], "declaration limitations", 32)
    .map((item) => safeText(item, "declaration limitation", MAX_LIMITATION_CHARACTERS));
  if (limitations.reduce((total, item) => total + item.length, 0) > MAX_LIMITATION_CHARACTERS) {
    fail(`declaration limitations exceed ${MAX_LIMITATION_CHARACTERS} characters in total.`);
  }
  return { schemaVersion: 1, intent, targets, objectives, limitations };
}

export function optimizationDeclarationDigest(input: unknown): string {
  return improvementDigest(normalizeOptimizationDeclarationV1(input));
}

/** Versioned approval binding over the exact release, artifact, and declaration revision. */
export function optimizationDeclarationApprovalDigest(input: {
  releaseId: string;
  artifactSha256: string;
  declarationRevisionId: string;
  declarationSha256: string;
}): string {
  return improvementDigest({
    schemaVersion: 1,
    kind: "myskills.optimization-declaration-approval",
    releaseId: input.releaseId,
    artifactSha256: sha256Field(input.artifactSha256, "artifactSha256"),
    declarationRevisionId: input.declarationRevisionId,
    declarationSha256: sha256Field(input.declarationSha256, "declarationSha256"),
  });
}

/**
 * True when a tested profile target falls inside one declared tuple. Every declared dimension must
 * match: declared capabilities must all be present in the profile, and a declared network mode must
 * equal the profile's. Absent dimensions are not declared and therefore do not restrict; separately
 * tested dimensions never combine.
 */
export function optimizationTargetMatchesProfile(target: OptimizationTargetV1, profileTarget: {
  model: ImprovementModelRefV1;
  app: { id: string; version: string };
  environment: { os: ImprovementOperatingSystem[]; requiredCapabilities: string[]; network: ImprovementNetworkMode };
}): boolean {
  if (target.models && !target.models.some((model) => model.provider === profileTarget.model.provider && model.id === profileTarget.model.id)) return false;
  if (target.apps && !target.apps.some((app) => app.id === profileTarget.app.id && (app.version === undefined || app.version === profileTarget.app.version))) return false;
  const declaredOs = target.environment?.os;
  if (declaredOs && (profileTarget.environment.os.length === 0 || profileTarget.environment.os.some((os) => !declaredOs.includes(os)))) return false;
  const declaredCapabilities = target.environment?.requiredCapabilities;
  if (declaredCapabilities && declaredCapabilities.some((capability) => !profileTarget.environment.requiredCapabilities.includes(capability))) return false;
  const declaredNetwork = target.environment?.network;
  if (declaredNetwork !== undefined && declaredNetwork !== profileTarget.environment.network) return false;
  return true;
}

export function normalizeImprovementModelRef(input: unknown, field: string): ImprovementModelRefV1 {
  const record = objectInput(input, field, ["provider", "id"]);
  return { provider: identifier(record.provider, `${field} provider`), id: identifier(record.id, `${field} id`) };
}

function normalizeTarget(input: unknown, index: number): OptimizationTargetV1 {
  const field = `declaration target ${index + 1}`;
  const record = objectInput(input, field, ["id", "models", "apps", "environment"]);
  const target: OptimizationTargetV1 = { id: identifier(record.id, `${field} id`) };
  if (record.models !== undefined) {
    const models = arrayField(record.models, `${field} models`, MAX_DIMENSION_ENTRIES, { minItems: 1 })
      .map((model) => normalizeImprovementModelRef(model, `${field} model`));
    target.models = dedupe(models, (model) => `${model.provider}\u0000${model.id}`);
  }
  if (record.apps !== undefined) {
    const apps = arrayField(record.apps, `${field} apps`, MAX_DIMENSION_ENTRIES, { minItems: 1 }).map((app) => {
      const appRecord = objectInput(app, `${field} app`, ["id", "version"]);
      return {
        id: identifier(appRecord.id, `${field} app id`),
        ...(appRecord.version === undefined ? {} : { version: identifier(appRecord.version, `${field} app version`) }),
      };
    });
    target.apps = dedupe(apps, (app) => `${app.id}\u0000${app.version ?? ""}`);
  }
  if (record.environment !== undefined) {
    const environment = objectInput(record.environment, `${field} environment`, ["os", "requiredCapabilities", "network"]);
    const normalized: OptimizationEnvironmentV1 = {};
    if (environment.os !== undefined) normalized.os = uniqueEnumArray(environment.os, `${field} os`, improvementOperatingSystems, MAX_DIMENSION_ENTRIES, { minItems: 1 });
    if (environment.requiredCapabilities !== undefined) {
      normalized.requiredCapabilities = uniqueIdentifierArray(environment.requiredCapabilities, `${field} requiredCapabilities`, MAX_CAPABILITIES);
    }
    if (environment.network !== undefined) normalized.network = enumValue(environment.network, `${field} network`, improvementNetworkModes);
    target.environment = normalized;
  }
  return target;
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
