export function proveCodexRecognition(input: { workspace: string; slug: string; binary?: string }): Promise<{
  runtime: "codex";
  method: "skills/list";
  recognized: true;
  slug: string;
  scope: string;
  modelTurnCreated: false;
}>;
