import { composeSkillUpgradePolicies } from "@myskills-app/core";
import { createHash, randomBytes } from "node:crypto";
import { AuthService } from "../../src/auth/service.js";
import { MemoryOAuthStore } from "../../src/oauth/memory-store.js";
import { OAuthService } from "../../src/oauth/service.js";
import { parseOAuthConfig } from "../../src/oauth/config.js";
import type { TestContext } from "node:test";
import { buildApp } from "../../src/app.js";
import { MemoryArchitectureSyncStore } from "../../src/architecture-sync/memory-store.js";
import { ArchitecturePlanService, type ArchitecturePlanDependencies } from "../../src/architecture-sync/plan-service.js";
import { ArchitectureArtifactService } from "../../src/architecture-sync/artifact-service.js";
import { createArchitecturePlanFixture } from "./architecture-plan-fixture.js";

/** Explicit shared test coordinator. Ordinary memory review stores cannot execute. */
export class ArtifactFixtureCoordinator {
  private tail:Promise<unknown>=Promise.resolve();
  run<T>(operation:()=>Promise<T>):Promise<T>{const next=this.tail.then(operation,operation);this.tail=next.catch(()=>undefined);return next;}
}
class FixtureStore extends MemoryArchitectureSyncStore {
  constructor(private readonly authority:ArtifactFixtureCoordinator,private readonly dependencies:ArchitecturePlanDependencies,now:()=>Date){super({now});}
  withArtifactAuthority<T>(_input:{actorId:string;targetId:string},operation:(store:MemoryArchitectureSyncStore,dependencies:ArchitecturePlanDependencies)=>Promise<T>):Promise<T>{
    return this.authority.run(async()=>{
      // Transaction rollback for journal Maps. All authority writers in this
      // fixture use the same coordinator; this is never production authority.
      const state=this as unknown as Record<string,unknown>;
      const snapshots=new Map(Object.entries(state).filter(([,v])=>v instanceof Map).map(([k,v])=>[k,structuredClone(v)]));
      try{return await operation(this,this.dependencies);}catch(error){for(const [key,value]of snapshots)state[key]=value;throw error;}
    });
  }
}
export async function createArchitectureArtifactFixture(t:Pick<TestContext,"after">,oauthEnabled=false){
  const fixture=await createArchitecturePlanFixture(t,true);const coordinator=new ArtifactFixtureCoordinator();
  let sequence=0;let clock=Date.now();let credentialDenied=false;const policy={constraints:composeSkillUpgradePolicies({}),revision:1};const now=()=>new Date(clock);
  const dependencies:ArchitecturePlanDependencies={architectureStore:fixture.architectureStore,targetStore:fixture.targetStore,releaseDependencies:{skillRepository:fixture.skillRepository,submissionService:fixture.submissionService},artifactSubmissions:fixture.submissionService,authorityNow:async()=>now(),readPolicyConstraints:async()=>policy,assertArtifactCredential:async(actor)=>{if(actor.artifactCredential?.kind==="session"&&!fixture.authStore.hasActiveSessionSync(actor.artifactCredential.hash,actor.id,new Date(clock)))throw new Error("Fixture session revoked at authority boundary.");if(credentialDenied)throw new Error("Synthetic current credential denied.");}};
  const store=new FixtureStore(coordinator,dependencies,now);const plans=new ArchitecturePlanService(store,dependencies);const artifacts=new ArchitectureArtifactService(store,dependencies);
  const oauth=oauthEnabled ? new OAuthService({store:new MemoryOAuthStore(fixture.authStore),authStore:fixture.authStore,config:parseOAuthConfig({NODE_ENV:"production",MYSKILLS_OAUTH_ENABLED:"true",MYSKILLS_OAUTH_ISSUER:"http://127.0.0.1:43999",MYSKILLS_MCP_PUBLIC_URL:"http://127.0.0.1:43999/mcp",APP_BASE_URL:"http://127.0.0.1:43999",MYSKILLS_OAUTH_CLIENTS:JSON.stringify([{client_id:"composed-fixture",client_name:"Composed fixture",redirect_uris:["https://fixture.example.test/callback"]}])})!}) : undefined;
  const app=buildApp({registryInstanceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",authService:oauth ? new AuthService(fixture.authStore,{oauthAccessTokens:oauth}) : fixture.authService,oauthService:oauth,architectureStore:fixture.architectureStore,architectureTargetService:fixture.targetService,submissionService:fixture.submissionService,skillRepository:fixture.skillRepository,architecturePlanService:plans,architectureArtifactService:artifacts});t.after(()=>app.close());
  async function review(targetId=fixture.target.id,revisionId=fixture.revision.id){const target=await fixture.targetService.getTarget(fixture.ownerId,targetId);const observations=await fixture.targetStore.listObservations({actor:fixture.ownerId,targetId,limit:1});const created=await plans.createPlan({id:fixture.ownerId,mfaVerified:true},targetId,{revisionId,expectedTargetGeneration:target!.generation,expectedObservationId:observations![0].id!,expectedObservationDigest:observations![0].observedDigest,idempotencyKey:`fixture-review-${++sequence}`});return (await plans.approvePlan({id:fixture.ownerId,mfaVerified:true},created.run.identity.runId,{expectedReviewDigest:String(created.run.metadata!.reviewDigest)})).run;}
  async function connectOAuth(scope:string){
    const verifier=randomBytes(32).toString("base64url");const params=new URLSearchParams({response_type:"code",client_id:"composed-fixture",redirect_uri:"https://fixture.example.test/callback",scope,state:"fixture-state",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",resource:"http://127.0.0.1:43999/mcp"});
    const authorized=await app.inject({url:`/oauth/authorize?${params}`});if(authorized.statusCode!==302)throw new Error(authorized.body);
    const handle=new URLSearchParams(new URL(String(authorized.headers.location)).hash.slice(1)).get("request");const decision=await app.inject({method:"POST",url:"/v1/oauth/consent/decision",headers:{authorization:`Bearer ${fixture.sessions.owner}`},payload:{request:handle,decision:"approve"}});if(decision.statusCode!==200)throw new Error(decision.body);
    const code=new URL(decision.json().redirectTo).searchParams.get("code")!;const token=await app.inject({method:"POST",url:"/oauth/token",headers:{"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams({grant_type:"authorization_code",client_id:"composed-fixture",code,code_verifier:verifier,redirect_uri:"https://fixture.example.test/callback",resource:"http://127.0.0.1:43999/mcp"}).toString()});if(token.statusCode!==200)throw new Error(token.body);return token.json() as {access_token:string};
  }
  return {...fixture,app,connectOAuth,coordinator,store,plans,artifacts,policy,review,actor:{id:fixture.ownerId,mfaVerified:true},setTime:(value:string)=>{clock=Date.parse(value);},advance:(ms:number)=>{clock+=ms;},denyCredential:()=>{credentialDenied=true;}};
}
