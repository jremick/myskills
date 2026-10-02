import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@myskills-app/core";
import type { ArchitecturePlanActor } from "./plan-service.js";
import type { ArchitectureArtifactService, PrepareArchitectureArtifactInput, ArtifactExecutionInput, ArtifactFenceInput } from "./artifact-service.js";
export function registerArchitectureArtifactRoutes(app:FastifyInstance,options:{service:ArchitectureArtifactService;authenticate(request:FastifyRequest,reply:FastifyReply):Promise<ArchitecturePlanActor|null>}) {
  app.post("/v1/architecture-targets/:id/artifacts",async(request,reply)=>{const actor=await options.authenticate(request,reply);if(!actor)return;const result=await options.service.prepare(actor,id(request.params),request.body as PrepareArchitectureArtifactInput);return reply.code(result.replayed?200:201).send(result);});
  app.get("/v1/architecture-artifacts/:id",async(request,reply)=>{const actor=await options.authenticate(request,reply);if(actor)return options.service.inspect(actor,id(request.params));});
  app.post("/v1/architecture-artifacts/:id/approve",async(request,reply)=>{const actor=await options.authenticate(request,reply);if(actor)return options.service.approve(actor,id(request.params),request.body as ArtifactExecutionInput);});
  app.post("/v1/architecture-artifacts/:id/claim",async(request,reply)=>{const actor=await options.authenticate(request,reply);if(actor)return options.service.claim(actor,id(request.params),request.body as {holderId:string;expectedIntentDigest:string});});
  app.post("/v1/architecture-artifacts/:id/checkpoint",async(request,reply)=>{const actor=await options.authenticate(request,reply);if(actor)return options.service.checkpoint(actor,id(request.params),request.body as ArtifactFenceInput);});
  app.post("/v1/architecture-artifacts/:id/receipt",async(request,reply)=>{const actor=await options.authenticate(request,reply);if(actor)return options.service.receipt(actor,id(request.params),request.body as Required<ArtifactFenceInput>);});
  app.post("/v1/architecture-artifacts/:id/rollback",async(request,reply)=>{const actor=await options.authenticate(request,reply);if(actor)return options.service.rollback(actor,id(request.params),request.body as ArtifactExecutionInput&{holderId:string});});
}
function id(params:unknown):string{const value=(params as {id?:unknown})?.id;if(typeof value!=="string"||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))throw new AppError("Artifact identifier is invalid.","INVALID_REQUEST_BODY",400);return value;}
