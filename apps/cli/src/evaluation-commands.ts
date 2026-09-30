import { lstat } from "node:fs/promises";
import { normalizeImprovementEvaluationSuiteV1 } from "@myskills-app/core";
import { defaultPackageEvaluationSuite, evaluatePackageFiles, readPackageFilesFromPath } from "@myskills-app/skill-package";
import type { ParityCommandContext, ParityCommandInput } from "./parity-types.js";
export const evaluationHelp = [
  "  evals local <package-directory-or-zip> --platform <name> [--suite <json-file>] [--json]",
  "  evals run <slug> <version> --input <json-file> [--json]",
  "  evals list|summary <slug> <version> [--json]",
];
export async function runEvaluationCommand(input: ParityCommandInput, context: ParityCommandContext): Promise<boolean> {
  if (input.command !== "evals") return false;
  const [action,...args]=input.args;
  const allowed = new Set(["json", ...(action === "local" ? ["platform","suite"] : ["api-url","token",...(action === "run" ? ["input"] : [])])]);
  if (Object.keys(input.options).some(key=>!allowed.has(key))) throw new Error("Unknown evaluation option.");
  if (action === "local") {
    if (args.length!==1 || typeof input.options.platform!=="string") throw new Error("Local eval requires one package path and --platform.");
    let files;
    try {
      const kind=await lstat(args[0]!);
      if (!kind.isDirectory() && !(kind.isFile() && args[0]!.toLowerCase().endsWith(".zip"))) throw new Error("Unsupported input kind.");
      files=await readPackageFilesFromPath(args[0]!);
    }
    catch { throw new Error("Package input could not be read safely. Use a bounded directory or ZIP archive with regular text files."); }
    const suite = input.options.suite === undefined ? defaultPackageEvaluationSuite() : normalizeImprovementEvaluationSuiteV1(await readInput(context,option(input,"suite")));
    context.output({ run: evaluatePackageFiles({files,suite,target:{platform:input.options.platform,context:"local"},provenance:"self-reported"}), notice: "Static local evidence is self-reported. Provider behavior is unconfigured. Nothing was uploaded; this result cannot approve or publish a version." });
    return true;
  }
  if (!action || action === "help") { context.output({usage:evaluationHelp}); return true; }
  if (!["run","list","summary"].includes(action) || args.length!==2 || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(args[0]!) || args[1]!.length>64 || !/^[0-9A-Za-z.+-]+$/.test(args[1]!)) throw new Error("Invalid evaluation command.");
  const root=`/v1/evaluations/releases/${encodeURIComponent(args[0]!)}/${encodeURIComponent(args[1]!)}`;
  if (action === "run") context.output(await context.request("POST",`${root}/runs`,await readInput(context,option(input,"input"))));
  else context.output(await context.request("GET",`${root}/${action === "list" ? "runs" : "summary"}`,undefined,action === "summary" ? "optional" : "required"));
  return true;
}
function option(input: ParityCommandInput,key:string):string { const value=input.options[key]; if(typeof value!=="string" || !value) throw new Error(`--${key} requires a file.`); return value; }

async function readInput(context:ParityCommandContext,path:string) { try { return await context.readInput(path); } catch { throw new Error("Evaluation input must be a bounded valid JSON object."); } }
