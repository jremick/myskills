import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import type { EvaluationService } from "../src/evaluations/service.js";

test("evaluation HTTP contracts reject invented authority and unusable credentials without public fallback",async t=>{
  const authStore=new MemoryAuthStore();const user=(await authStore.createUserWithPassword({email:"eval-http@example.com",name:"HTTP",passwordHash:await hashPassword("Evaluation-http-password-827!")})).user!;
  await authStore.updateUserStatus({userId:user.id,status:"active",emailVerifiedAt:new Date()});
  const calls:unknown[]=[];
  const evaluator={create:async(actor:unknown,input:unknown)=>{calls.push({actor,input});return {run:{id:"contract-run"},created:true};},list:async(...args:unknown[])=>{calls.push(args);return [];}} as unknown as EvaluationService;
  const app=buildApp({skillRepository:new MemorySkillRepository(),authService:new AuthService(authStore,{}),evaluationService:evaluator});t.after(()=>app.close());
  const login=await app.inject({method:"POST",url:"/v1/auth/login",payload:{email:user.email,password:"Evaluation-http-password-827!"}});const token=login.json().token;
  const root="/v1/evaluations/releases/fixture/1.0.0";const body={artifactSha256:"a".repeat(64),suiteRevisionId:"11111111-1111-4111-8111-111111111111",platform:"codex",idempotencyKey:"contract-evaluation"};
  const response=await app.inject({method:"POST",url:`${root}/runs`,headers:{authorization:`Bearer ${token}`},payload:body});assert.equal(response.statusCode,201,response.body);
  const captured=calls[0] as {actor:{credential:{tokenHash:string}};input:unknown};assert.equal(captured.actor.credential.tokenHash.length,64);assert.deepEqual(captured.input,{slug:"fixture",version:"1.0.0",...body});
  const count=calls.length;
  for(const url of [`${root}/runs`,`${root}/summary`]){const denial=await app.inject({method:"GET",url,headers:{authorization:"Bearer revoked-or-invalid"}});assert.equal(denial.statusCode,401);}
  assert.equal(calls.length,count);
  for(const invalid of [{...body,provenance:"api-owned"},{...body,result:{status:"pass"}},{...body,runner:{id:"trusted"}},{...body,artifactSha256:"bad"}])assert.equal((await app.inject({method:"POST",url:`${root}/runs`,headers:{authorization:`Bearer ${token}`},payload:invalid})).statusCode,400);
  assert.equal((await app.inject({method:"GET",url:`${root}/summary`})).statusCode,200);
  assert.equal((await app.inject({method:"GET",url:`${root}/runs`})).statusCode,401);
});
