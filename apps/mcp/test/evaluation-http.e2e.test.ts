import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client,StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { APPLICATION_SCOPES } from "@myskills-app/core";
import { createAiSkillsMcpHttpServer } from "../src/http.js";
// Protocol/transport fixture only. The API PG journey proves result persistence and authority.
test("MCP evaluation tools preserve exact bindings, return statuses and propagate denial without fallback",async t=>{
  const requests:Array<{method:string;path:string;body:unknown}>=[];
  const api=createServer(async(request,response)=>{
    response.setHeader("content-type","application/json");
    if(request.url==="/v1/mcp/session"){response.end(JSON.stringify({credential:{kind:"oauth",grantId:"fixture",clientId:"fixture",scopes:[...APPLICATION_SCOPES],resource:"http://127.0.0.1:43998/mcp"}}));return;}
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString();requests.push({method:request.method!,path:request.url!,body:body?JSON.parse(body):null});
    if(request.url!.includes("/denied/")){response.statusCode=403;response.end(JSON.stringify({error:{code:"API_TOKEN_SCOPE_REQUIRED",message:"PRIVATE-ERROR-CANARY"}}));}
    else response.end(JSON.stringify({runs:[],contractFixture:true}));
  });
  await new Promise<void>(done=>api.listen(0,"127.0.0.1",done));t.after(()=>new Promise<void>(done=>api.close(()=>done())));
  const mcp=createAiSkillsMcpHttpServer({apiBaseUrl:`http://127.0.0.1:${(api.address() as AddressInfo).port}`,oauth:{issuer:"http://127.0.0.1:43999",resourceUrl:"http://127.0.0.1:43998/mcp"}});
  await new Promise<void>(done=>mcp.listen(0,"127.0.0.1",done));t.after(()=>new Promise<void>(done=>mcp.close(()=>done())));
  const client=new Client({name:"evaluation-transport",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`),{requestInit:{headers:{authorization:"Bearer fixture-token"}}}));t.after(()=>client.close());
  const tools=await client.listTools();for(const name of ["evaluations_run","evaluations_list","evaluations_summary"])assert.ok(tools.tools.some(tool=>tool.name===name));
  const body={artifactSha256:"a".repeat(64),suiteRevisionId:"11111111-1111-4111-8111-111111111111",platform:"codex",idempotencyKey:"mcp-replay"};
  const result=await client.callTool({name:"evaluations_run",arguments:{path:{slug:"fixture",version:"1.0.0"},body}});assert.equal(result.isError,undefined,JSON.stringify(result));
  assert.deepEqual(requests.at(-1),{method:"POST",path:"/v1/evaluations/releases/fixture/1.0.0/runs",body});
  const count=requests.length;const invalid=await client.callTool({name:"evaluations_run",arguments:{path:{slug:"fixture",version:"1.0.0"},body:{...body,result:{status:"pass"}}}});assert.equal(invalid.isError,true);assert.equal(requests.length,count);
  const denial=await client.callTool({name:"evaluations_list",arguments:{path:{slug:"denied",version:"1.0.0"}}});assert.equal(denial.isError,true);assert.equal(requests.length,count+1);assert.equal(JSON.stringify(denial).includes("PRIVATE-ERROR-CANARY"),false);
});
