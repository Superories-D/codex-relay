import { z } from "zod";
const identity=z.string().min(1).max(200),time=z.number().finite();
export const operationFactSchema=z.object({
  id:identity,title:z.string().max(1000),familyId:identity,project:z.string().max(1000),projectKey:z.string().regex(/^[a-f0-9]{64}$/),
  state:z.enum(["queued","preparing","running","pausing","rotating","waiting","watching","paused","needs_attention","completed","cancelled"]),
  archived:z.boolean(),intent:z.enum(["pause","cancel"]).optional(),waitingFor:z.enum(["model","recovery"]).optional(),
  active:z.boolean(),controlling:z.boolean(),accountId:identity.optional(),rotations:z.number().int().nonnegative(),queued:z.number().int().nonnegative(),
  workflow:z.object({id:identity,title:z.string().max(1000),step:z.number().int().positive(),total:z.number().int().positive()}).strict().optional(),
  recovery:z.object({required:z.boolean(),attempt:z.number().int().nonnegative(),reason:z.enum(["process","interrupted","unknown"]).optional(),nextAt:time.optional(),
    last:z.object({at:time,kind:z.enum(["scheduled","resumed","stopped","completed"]),attempt:z.number().int().nonnegative()}).strict().optional()}).strict(),
  acceptance:z.object({revision:z.number().int().nonnegative(),reportId:identity.optional(),status:z.enum(["none","pending","passed","failed","unverified","stale"])}).strict(),
  requests:z.array(z.object({id:identity,reviewId:z.string().uuid().optional(),historyId:identity.optional(),kind:z.enum(["command","file","input","permissions","elicitation","unsupported"]),pending:z.boolean()}).strict()),
}).strict();
export type OperationFact=z.infer<typeof operationFactSchema>;
export const operationDispatchSchema=z.object({paused:z.boolean(),projects:z.array(z.object({key:z.string().regex(/^[a-f0-9]{64}$/),label:z.string().max(1000)}).strict())}).strict();
export const observationSchema=z.object({at:time,facts:z.array(operationFactSchema),dispatch:operationDispatchSchema}).strict();
export type OperationObservation=z.infer<typeof observationSchema>;
const sequence=z.string().regex(/^[1-9]\d{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n);
export const operationQuerySchema=z.object({taskId:identity.optional(),familyId:identity.optional(),projectKey:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  cursor:z.object({before:sequence.optional(),ceiling:sequence,filter:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),limit:z.number().int().min(1).max(100).default(40)}).strict();
export type OperationQuery=z.input<typeof operationQuerySchema>;
export type OperationEventKind="session"|"baseline"|"changed"|"removed"|"dispatch";
export interface OperationEvent {seq:string;at:number;sessionId:string;kind:OperationEventKind;taskId?:string;title?:string;
  changes:string[];current?:OperationFact;previous?:OperationFact;dispatch?:OperationObservation["dispatch"];previousAt?:number;gap?:boolean}
export interface OperationPage {events:OperationEvent[];cursor?:NonNullable<z.infer<typeof operationQuerySchema>["cursor"]>;position?:NonNullable<z.infer<typeof operationQuerySchema>["cursor"]>;ceiling?:string}
export interface RecordingStatus {phase:"starting"|"recording"|"failed"|"closed";issue?:string;lastSeq?:string;lastAt?:number;pending:number;gapSince?:number}
