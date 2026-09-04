export interface AcceptanceActor {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    status: string;
    roles: string[];
    emailVerified: boolean;
    mfaVerified: boolean;
  };
}

export interface AcceptanceCheck {
  name: string;
  passed: true;
  [key: string]: unknown;
}

export interface AcceptanceReport {
  schemaVersion: 1;
  passed: true;
  environment: "local" | "staging";
  slug: string;
  checks: AcceptanceCheck[];
  artifacts: { version: string; sha256: string; byteSize: number }[];
  runtimeRecognition: "not-tested";
}

export const feedbackReason: string;
export function acceptanceConfiguration(env?: Record<string, string | undefined>): {
  apiUrl: string;
  environment: "local" | "staging";
  expectedInstanceId?: string;
  cliPath: string;
};
export function runOperationalAcceptance(options?: {
  env?: Record<string, string | undefined>;
  onCheck?: (check: AcceptanceCheck) => void;
  callbacks?: {
    afterFeedback?: (context: { slug: string; actor: AcceptanceActor; reason: string }) => Promise<void>;
    afterPublish?: (context: { slug: string; actor: AcceptanceActor; version: string }) => Promise<void>;
    afterUnpublish?: (context: { slug: string; actor: AcceptanceActor; version: string }) => Promise<void>;
    afterArchive?: (context: { slug: string; actor: AcceptanceActor }) => Promise<void>;
    afterWorkspaceInstall?: (context: { workspace: string; slug: string; version: string; targetId: string; actor: AcceptanceActor }) => Promise<void>;
    afterPolicyBlocked?: (context: { slug: string; actor: AcceptanceActor; targetName: string;
      releases: { version: string; changeKind: string; releaseNotes: string }[] }) => Promise<void>;
    afterRevocation?: (context: { slug: string; actor: AcceptanceActor }) => Promise<void>;
  };
}): Promise<AcceptanceReport>;
