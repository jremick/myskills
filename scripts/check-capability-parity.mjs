import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const surfaces = ["api", "cli", "ui", "mcp_api_token", "mcp_oauth"];
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const unknown = Symbol("unresolved static value");
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const inventoryPath = "docs/capability-parity.json";
export const matrixPath = "docs/CAPABILITY_PARITY.md";

export function commandRoot(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--root");
  return index === -1 ? defaultRoot : path.resolve(argv[index + 1]);
}

async function sourceFiles(root, relative) {
  let entries;
  try { entries = await readdir(path.join(root, relative), {withFileTypes: true}); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) return sourceFiles(root, file);
    return /\.tsx?$/.test(file) && !/\.(test|spec|d)\.ts$/.test(file) ? [file] : [];
  }));
  return nested.flat().sort();
}

/** Read registration syntax without running application code or using source hashes. */
export async function discoverSurfaces(root) {
  const files = (await Promise.all(["apps/api/src", "apps/cli/src", "apps/mcp/src"].map((dir) => sourceFiles(root, dir)))).flat();
  const program = ts.createProgram(files.map((file) => path.join(root, file)), {noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, baseUrl: root, paths: {"@myskills-app/core": ["packages/core/src/index.ts"]}});
  const checker = program.getTypeChecker();
  const found = {api: [], tools: [], handlers: [], commands: [], errors: []};
  const symbolFor = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };
  function evaluate(node, env, depth = 0) {
    if (!node || depth > 30) return unknown;
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return evaluate(node.expression, env, depth + 1);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : symbolFor(node);
      if (env.has(symbol ?? node.text)) return env.get(symbol ?? node.text);
      const declaration = symbol?.valueDeclaration;
      return declaration?.initializer ? evaluate(declaration.initializer, env, depth + 1) : unknown;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((item) => {
      if (!ts.isSpreadElement(item)) return [evaluate(item, env, depth + 1)];
      const expanded = evaluate(item.expression, env, depth + 1);
      return Array.isArray(expanded) ? expanded : [unknown];
    });
    if (ts.isObjectLiteralExpression(node)) {
      const result = {};
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return unknown;
        result[property.name.getText().replace(/^['"]|['"]$/g, "")] = evaluate(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer, env, depth + 1);
      }
      return result;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const value = evaluate(node.expression, env, depth + 1);
      return value !== unknown && value != null && Object.hasOwn(value, node.name.text) ? value[node.name.text] : unknown;
    }
    if (ts.isElementAccessExpression(node)) {
      const value = evaluate(node.expression, env, depth + 1);
      const key = evaluate(node.argumentExpression, env, depth + 1);
      return value !== unknown && key !== unknown && value != null && Object.hasOwn(value, key) ? value[key] : unknown;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = evaluate(span.expression, env, depth + 1);
        if (part === unknown || typeof part === "object") return unknown;
        value += String(part) + span.literal.text;
      }
      return value;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = symbolFor(node.expression)?.valueDeclaration;
      const fn = ts.isFunctionDeclaration(declaration ?? {}) ? declaration : declaration?.initializer;
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) && fn.body) {
        const nested = new Map(env);
        for (let index = 0; index < fn.parameters.length; index++) {
          const parameter = fn.parameters[index];
          const value = node.arguments[index] ? evaluate(node.arguments[index], env, depth + 1) : evaluate(parameter.initializer, nested, depth + 1);
          bind(parameter.name, value, nested);
        }
        if (!ts.isBlock(fn.body)) return evaluate(fn.body, nested, depth + 1);
        if (fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0])) return evaluate(fn.body.statements[0].expression, nested, depth + 1);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = evaluate(node.expression.expression, env, depth + 1);
      const method = node.expression.name.text;
      if (method === "replaceAll" && typeof receiver === "string") {
        const args = node.arguments.map((argument) => evaluate(argument, env, depth + 1));
        if (args.length === 2 && args.every((argument) => typeof argument === "string")) return receiver.replaceAll(args[0], args[1]);
      }
      if (method === "map" && Array.isArray(receiver) && node.arguments.length === 1) {
        const callback = node.arguments[0];
        if (ts.isArrowFunction(callback) && !ts.isBlock(callback.body) && callback.parameters.length === 1) {
          return receiver.map((value) => {
            const nested = new Map(env);
            bind(callback.parameters[0].name, value, nested);
            return evaluate(callback.body, nested, depth + 1);
          });
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, env, depth + 1), right = evaluate(node.right, env, depth + 1);
      return left !== unknown && right !== unknown ? left + right : unknown;
    }
    return unknown;
  }
  function bind(name, value, env) {
    if (ts.isIdentifier(name)) env.set(symbolFor(name) ?? name.text, value);
    else if (ts.isArrayBindingPattern(name) && Array.isArray(value)) name.elements.forEach((element, i) => { if (ts.isBindingElement(element)) bind(element.name, value[i], env); });
    else if (ts.isObjectBindingPattern(name) && value && value !== unknown) name.elements.forEach((element) => bind(element.name, value[(element.propertyName ?? element.name).getText()], env));
  }
  function isFastify(receiver) {
    const declaration = symbolFor(receiver)?.valueDeclaration;
    return /FastifyInstance/.test(declaration?.type?.getText() ?? "") || /FastifyInstance/.test(checker.typeToString(checker.getTypeAtLocation(receiver))) || (ts.isIdentifier(receiver) && ["app", "scope"].includes(receiver.text));
  }
  for (const file of files) {
    const source = program.getSourceFile(path.join(root, file));
    const location = (node) => ({source: file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1});
    const cannotResolve = (kind, node) => found.errors.push(`cannot resolve ${kind} registration at ${file}:${location(node).line}; use a static registration contract or extend the extractor`);
    function visit(node, env) {
      if (ts.isForOfStatement(node)) {
        const values = evaluate(node.expression, env);
        if (Array.isArray(values) && values.every((value) => value !== unknown)) {
          const name = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0]?.name : node.initializer;
          for (const value of values) { const nested = new Map(env); bind(name, value, nested); visit(node.statement, nested); }
          return;
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const name = callee.name.text;
        if (file.startsWith("apps/api/") && ((methods.has(name) || name === "route") && isFastify(callee.expression))) {
          const route = name === "route" ? evaluate(node.arguments[0], env) : {url: evaluate(node.arguments[0], env), method: name};
          const routeMethods = Array.isArray(route?.method) ? route.method : [route?.method];
          if (!route || route === unknown || typeof route.url !== "string" || !route.url.startsWith("/") || routeMethods.some((method) => typeof method !== "string")) cannotResolve("API", node);
          else for (const method of routeMethods) found.api.push({method: method.toUpperCase(), path: route.url, ...location(node)});
        }
        if (file.startsWith("apps/mcp/") && ["registerTool", "setRequestHandler"].includes(name)) {
          const label = evaluate(node.arguments[0], env);
          if (typeof label !== "string") cannotResolve(name === "registerTool" ? "MCP tool" : "MCP handler", node);
          else if (name === "setRequestHandler") found.handlers.push({name: label, ...location(node)});
          else {
            const actions = new Set();
            const resolved = new Set();
            const resolveNode = (value) => {
              if (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) return resolveNode(value.expression);
              if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) {
                const symbol = ts.isIdentifier(value) && ts.isShorthandPropertyAssignment(value.parent)
                  ? checker.getShorthandAssignmentValueSymbol(value.parent) : symbolFor(value);
                const declaration = symbol?.valueDeclaration;
                if (declaration?.initializer && !resolved.has(declaration)) {
                  resolved.add(declaration);
                  return resolveNode(declaration.initializer);
                }
              }
              return value;
            };
            const inspected = new Set();
            const inspect = (original) => {
              const child = resolveNode(original);
              if (inspected.has(child)) return;
              inspected.add(child);
              if (ts.isPropertyAssignment(child) && ["action", "actionId"].includes(child.name.getText().replaceAll('"', "").replaceAll("'", ""))) {
                let hasEnum = false;
                const enums = (originalValue) => {
                  const value = resolveNode(originalValue);
                  if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "enum") {
                    hasEnum = true;
                    const choices = evaluate(value.arguments[0], env);
                    if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== "string")) cannotResolve("MCP action", value);
                    else choices.forEach((choice) => actions.add(choice));
                  }
                  ts.forEachChild(value, enums);
                };
                enums(child.initializer);
                if (!hasEnum) cannotResolve("MCP action", child);
              }
              ts.forEachChild(child, inspect);
            };
            const definition = node.arguments[1] && resolveNode(node.arguments[1]);
            if (!definition || !ts.isObjectLiteralExpression(definition)) cannotResolve("MCP tool schema", node);
            else {
              const schema = definition.properties.find((property) => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText() === "inputSchema");
              if (schema) inspect(ts.isPropertyAssignment(schema) ? schema.initializer : schema.name);
            }
            const metadata = evaluate(node.arguments[1], env)?._meta;
            found.tools.push({name: label, actions: [...actions].sort(), ...location(node),
              ...(typeof metadata?.actionId === "string" ? {actionId: metadata.actionId} : {}),
              ...(typeof metadata?.capabilityId === "string" ? {capabilityId: metadata.capabilityId} : {}),
            });
          }
        }
      }
      if (file.startsWith("apps/cli/") && ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
        const command = (value) => ts.isPropertyAccessExpression(value) && value.name.text === "command";
        const value = command(node.left) ? evaluate(node.right, env) : command(node.right) ? evaluate(node.left, env) : unknown;
        if (typeof value === "string") found.commands.push({name: value, ...location(node)});
      }
      if (file.startsWith("apps/cli/") && ts.isSwitchStatement(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "command") {
        for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause)) {
          const name = evaluate(clause.expression, env);
          if (typeof name !== "string") cannotResolve("CLI command", clause);
          else found.commands.push({name, ...location(clause)});
        }
      }
      ts.forEachChild(node, (child) => visit(child, env));
    }
    visit(source, new Map());
  }
  found.commands = [...new Map(found.commands.map((entry) => [entry.name, entry])).values()];
  return found;
}

function operationKey(operation) { return `${operation.method} ${operation.path}`; }
function compareEntries(actual, classified, label, key, errors) {
  const actualKeys = new Set(actual.map(key)), classifiedKeys = new Set(classified.map(key));
  for (const value of actualKeys) if (!classifiedKeys.has(value)) errors.push(`unclassified ${label} ${value}`);
  for (const value of classifiedKeys) if (!actualKeys.has(value)) errors.push(`removed ${label} ${value}`);
}
export async function validateInventory(root, inventory, found) {
  const errors = [...found.errors];
  if (inventory.schema_version !== 2) errors.push("schema_version must be 2");
  if (inventory.baseline_surface !== "ui" || JSON.stringify(inventory.priority_order) !== JSON.stringify(["api", "cli", "mcp"])) errors.push("priority must preserve UI baseline and API -> CLI -> MCP");
  const capabilities = inventory.capabilities ?? [], ids = new Set(), gaps = new Set((inventory.gaps ?? []).map((gap) => gap.id));
  const sourceCache = new Map();
  async function validateSource(source, context) {
    const relative = source.source ?? source.path;
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) { errors.push(`${context}: invalid source path`); return; }
    if (!sourceCache.has(relative)) { try { sourceCache.set(relative, (await readFile(path.join(root, relative), "utf8")).split("\n")); } catch { sourceCache.set(relative, null); } }
    const lines = sourceCache.get(relative);
    if (!lines || !Number.isInteger(source.line) || source.line < 1 || source.line > lines.length) errors.push(`${context}: invalid source location ${relative}:${source.line}`);
  }
  for (const row of capabilities) {
    if (!/^[A-Z][A-Z0-9]*-\d{2,}$/.test(row.id)) errors.push(`invalid capability ID ${row.id}`);
    if (ids.has(row.id)) errors.push(`duplicate capability ${row.id}`);
    ids.add(row.id);
    if (!row.capability || !row.domain || !row.authorization) errors.push(`${row.id}: missing capability/domain/authorization`);
    if (!gaps.has(row.gap)) errors.push(`${row.id}: unknown gap ${row.gap}`);
    for (const surface of surfaces) {
      const cell = row[surface];
      if (!cell || !["A", "P", "M", "B", "N"].includes(cell.status)) errors.push(`${row.id}/${surface}: invalid status ${cell?.status}`);
      if (!cell?.detail?.trim()) errors.push(`${row.id}/${surface}: status requires a reason`);
      if (!Array.isArray(cell?.evidence) || cell.evidence.length === 0 || cell.evidence.some((item) => !["source", "contract", "runtime", "host", "deployment"].includes(item.level) || !item.detail?.trim())) errors.push(`${row.id}/${surface}: evidence provenance required`);
      if (cell?.source) await validateSource(cell.source, `${row.id}/${surface}`);
      for (const evidence of cell?.evidence ?? []) if (evidence.source) await validateSource(evidence.source, `${row.id}/${surface} evidence`);
    }
    for (const operation of row.api_operations ?? []) await validateSource(operation, row.id);
  }
  const references = (entry, context) => {
    if (!Array.isArray(entry.capability_ids) || !entry.capability_ids.length) errors.push(`${context}: capability classification required`);
    for (const id of entry.capability_ids ?? []) if (!ids.has(id)) errors.push(`${context}: unknown capability ${id}`);
  };
  for (const field of ["mcp_tool_inventory", "native_mcp_handlers", "cli_command_inventory"]) {
    const names = new Set();
    for (const entry of inventory[field] ?? []) {
      if (names.has(entry.name)) errors.push(`${field}: duplicate name ${entry.name}`);
      names.add(entry.name);
      references(entry, entry.name);
      for (const action of entry.actions ?? []) references(action, `${entry.name}:${action.name}`);
    }
  }
  compareEntries(found.api, capabilities.flatMap((row) => row.api_operations ?? []), "API operation", operationKey, errors);
  compareEntries(found.tools, inventory.mcp_tool_inventory ?? [], "MCP tool", (item) => item.name, errors);
  compareEntries(found.handlers, inventory.native_mcp_handlers ?? [], "MCP handler", (item) => item.name, errors);
  compareEntries(found.commands, inventory.cli_command_inventory ?? [], "CLI command", (item) => item.name, errors);
  for (const tool of found.tools) {
    const classification = (inventory.mcp_tool_inventory ?? []).find((item) => item.name === tool.name);
    if (!classification) continue;
    if (tool.actionId && classification.action_id !== tool.actionId) errors.push(`MCP tool ${tool.name}: action classification differs from registration`);
    if (tool.capabilityId && !classification.capability_ids?.includes(tool.capabilityId)) errors.push(`MCP tool ${tool.name}: capability classification differs from registration`);
  }
  const actualActions = found.tools.flatMap((tool) => tool.actions.map((action) => ({name: `${tool.name}:${action}`})));
  const mappedActions = (inventory.mcp_tool_inventory ?? []).flatMap((tool) => (tool.actions ?? []).map((action) => ({name: `${tool.name}:${action.name}`})));
  compareEntries(actualActions, mappedActions, "MCP action", (item) => item.name, errors);
  return errors;
}

/** Reconcile locations only. Missing registrations and changed anchors require review. */
export async function refreshSources(root, inventory, found) {
  const byOperation = new Map(found.api.map((operation) => [operationKey(operation), operation]));
  for (const row of inventory.capabilities) {
    for (const operation of row.api_operations) {
      const current = byOperation.get(operationKey(operation));
      if (current) Object.assign(operation, {source: current.source, line: current.line});
    }
    for (const surface of surfaces) {
      const reference = row[surface]?.source;
      if (!reference?.anchor) continue;
      const lines = (await readFile(path.join(root, reference.path), "utf8")).split("\n");
      const matches = lines.flatMap((line, index) => line.trim() === reference.anchor ? [index + 1] : []);
      if (matches.length === 1) reference.line = matches[0];
      else if (lines[reference.line - 1]?.trim() !== reference.anchor) throw new Error(`${row.id}/${surface}: source anchor changed or ambiguous; inspect and update ${reference.path}`);
    }
  }
  for (const [field, current] of [["mcp_tool_inventory", found.tools], ["native_mcp_handlers", found.handlers], ["cli_command_inventory", found.commands]]) {
    for (const entry of inventory[field] ?? []) {
      const match = current.find((item) => item.name === entry.name);
      if (match) entry.source = {path: match.source, line: match.line};
    }
  }
  await writeFile(path.join(root, inventoryPath), JSON.stringify(inventory, null, 2) + "\n");
}

async function main() {
  const {renderMatrix} = await import("./render-capability-parity.mjs");
  const root = commandRoot();
  const inventory = JSON.parse(await readFile(path.join(root, inventoryPath), "utf8"));
  const found = await discoverSurfaces(root);
  const errors = await validateInventory(root, inventory, found);
  const current = await readFile(path.join(root, matrixPath), "utf8").catch(() => "");
  if (current !== renderMatrix(inventory)) errors.push("stale generated matrix; run npm run docs:parity");
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; return; }
  console.log(`Capability parity inventory: ${inventory.capabilities.length} groups, ${new Set(found.api.map(operationKey)).size} API operations, ${found.commands.length} CLI commands, ${found.tools.length} MCP tools, ${found.handlers.length} native handlers. Source classification and render are current; runtime parity is not implied.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
