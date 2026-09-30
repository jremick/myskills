import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAiSkillsMcpHttpServer } from "../src/http.js";
import { createArchitectureArtifactFixture } from "../../api/test/fixtures/architecture-artifact-fixture.js";

// SDK → MCP HTTP → actual API; preparation remains intent and CLI handoff.
test("MCP composed preparation preserves exact intent and cannot invent local apply",async t=>{
  const fixture=await createArchitectureArtifactFixture(t,true);const review=await fixture.review();
  const tokenResponse=await fixture.app.inject({method:"POST",url:"/v1/auth/api-tokens",headers:{authorization:`Bearer ${fixture.sessions.owner}`},payload:{name:"Synthetic artifact transport",scopes:["targets:read","targets:control","architectures:read","skills:read"]}});assert.equal(tokenResponse.statusCode,201,tokenResponse.body);
  let writes=0;const server=createAiSkillsMcpHttpServer({apiBaseUrl:"http://fixture.test",oauth:{issuer:"http://127.0.0.1:43999",resourceUrl:"http://127.0.0.1:43999/mcp"},fetchImpl:async(url,init)=>{
    if(init?.method==="POST"&&new URL(url).pathname!=="/v1/mcp/session")writes++;
    const response=await fixture.app.inject({method:(init?.method??"GET") as "GET"|"POST",url:new URL(url).pathname+new URL(url).search,headers:init?.headers,...(init?.body?{payload:JSON.parse(init.body)}:{})});return new Response(response.body,{status:response.statusCode,headers:response.headers as Record<string,string>});
  }});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const client=new Client({name:"composed-transport",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${tokenResponse.json().token.token}`}}}));t.after(()=>client.close());
  const tools=(await client.listTools()).tools;assert.equal(tools.find(tool=>tool.name==="architecture_artifacts_prepare")?.annotations?.readOnlyHint,false);assert.ok(!tools.some(tool=>tool.name==="architecture_artifacts_apply"));
  const args={path:{id:fixture.target.id},body:{reviewRunId:review.identity.runId,baselineRunId:null,idempotencyKey:"mcp-intent"}};
  const candidate=await client.callTool({name:"architecture_artifacts_prepare",arguments:args});assert.equal(candidate.isError,undefined,JSON.stringify(candidate));
  const artifact=candidate.structuredContent as {run:{identity:{runId:string};state:string;approval?:unknown};intent:{treeDigest:string};runtimeRecognized:boolean};assert.equal(artifact.run.state,"drafted");assert.equal(artifact.run.approval,undefined);assert.equal(artifact.runtimeRecognized,false);
  const read=await client.callTool({name:"architecture_artifacts_get",arguments:{path:{id:artifact.run.identity.runId}}});assert.equal(read.isError,undefined,JSON.stringify(read));assert.deepEqual((read.structuredContent as typeof artifact).intent,artifact.intent);
  const before=writes;const invented=await client.callTool({name:"architecture_artifacts_prepare",arguments:{...args,body:{...args.body,apply:true}}});assert.equal(invented.isError,true);assert.equal(writes,before);
  const oauth=await fixture.connectOAuth("targets:read targets:control architectures:read skills:read");
  const oauthClient=new Client({name:"composed-oauth",version:"1"});await oauthClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${oauth.access_token}`}}}));t.after(()=>oauthClient.close());
  const delegated=await oauthClient.callTool({name:"architecture_artifacts_prepare",arguments:{...args,body:{...args.body,idempotencyKey:"oauth-intent"}}});assert.equal(delegated.isError,undefined,JSON.stringify(delegated));
  const oauthArtifact=delegated.structuredContent as typeof artifact;
  const get=await oauthClient.callTool({name:"architecture_artifacts_get",arguments:{path:{id:oauthArtifact.run.identity.runId}}});assert.equal(get.isError,undefined,JSON.stringify(get));
  const execute=await fixture.app.inject({method:"POST",url:`/v1/architecture-artifacts/${oauthArtifact.run.identity.runId}/approve`,headers:{authorization:`Bearer ${oauth.access_token}`},payload:{}});assert.equal(execute.statusCode,403);
  const narrow=await fixture.connectOAuth("targets:read architectures:read");const denied=await fixture.app.inject({method:"POST",url:`/v1/architecture-targets/${fixture.target.id}/artifacts`,headers:{authorization:`Bearer ${narrow.access_token}`},payload:args.body});assert.equal(denied.statusCode,403);
  assert.equal((await fixture.store.getRun(review.identity.runId))!.metadata!.reviewOnly,true);
});
