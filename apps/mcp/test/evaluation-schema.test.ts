import assert from "node:assert/strict";
import test from "node:test";
import { DELEGATED_ACTIONS } from "@myskills-app/core";
import { applicationInputSchema } from "../src/application-schemas.js";
test("MCP evaluation contracts expose existing scopes and reject supplied results or provenance",()=>{
  const action=DELEGATED_ACTIONS.find(a=>a.id==="evaluations.run")!;assert.ok(action);assert.deepEqual(action.requiredScopes,["improvements:run"]);
  const schema=applicationInputSchema(action);
  const input={path:{slug:"fixture",version:"1.0.0"},body:{artifactSha256:"a".repeat(64),suiteRevisionId:"11111111-1111-4111-8111-111111111111",platform:"codex",idempotencyKey:"mcp-evaluation"}};
  assert.equal(schema.safeParse(input).success,true);
  for(const field of ["result","runner","provenance","actorId"])assert.equal(schema.safeParse({...input,body:{...input.body,[field]:"invented"}}).success,false);
  const summary=DELEGATED_ACTIONS.find(a=>a.id==="evaluations.summary")!;assert.deepEqual(summary.requiredScopes,[]);assert.equal(summary.classification,"public_metadata");
});
