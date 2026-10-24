import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createHash,randomUUID } from "node:crypto";
import path from "node:path";
import { operationFactSchema,operationDispatchSchema,operationQuerySchema,type OperationFact,type OperationEvent,type OperationPage } from "../shared/operations";
import { z } from "zod";
const port=parentPort!;
let db:DatabaseSync|undefined,sessionId="";
const deltaSchema=z.object({at:z.number().finite(),baseline:z.boolean(),facts:z.array(operationFactSchema),removed:z.array(z.string().min(1).max(200)),dispatch:operationDispatchSchema.optional()}).strict();
const requireDB=()=>{if(!db)throw Error("Operations history is not open");return db;};
function insert(event:Omit<OperationEvent,"seq">) {
  requireDB().prepare("INSERT INTO events(at,session,kind,task,family,project,body) VALUES(?,?,?,?,?,?,?)").run(event.at,event.sessionId,event.kind,event.taskId??null,
    event.current?.familyId??event.previous?.familyId??null,event.current?.projectKey??event.previous?.projectKey??null,JSON.stringify(event));
}
function checkpoint(){const row=requireDB().prepare("SELECT seq,at FROM events ORDER BY seq DESC LIMIT 1");row.setReadBigInts(true);const value=row.get();return value?{lastSeq:String(value.seq),lastAt:Number(value.at)}:{};}
function open(file:unknown) {
  if(db)throw Error("Operations history is already open");
  if(typeof file!=="string"||!path.isAbsolute(file))throw Error("Invalid history path");
  const opened=new DatabaseSync(file);db=opened;
  try{
    const version=Number(opened.prepare("PRAGMA user_version").get()!.user_version);
    if(version!==0&&version!==1)throw Error("Unsupported operations history version");
    if(version===0){
      if(opened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw Error("Unrecognized operations database");
      opened.exec("BEGIN IMMEDIATE;CREATE TABLE current(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,session TEXT NOT NULL,kind TEXT NOT NULL,task TEXT,family TEXT,project TEXT,body TEXT NOT NULL);CREATE INDEX events_task ON events(task,seq);CREATE INDEX events_family ON events(family,seq);CREATE INDEX events_project ON events(project,seq);PRAGMA application_id=1129467728;PRAGMA user_version=1;COMMIT;");
    }
    if(Number(opened.prepare("PRAGMA application_id").get()!.application_id)!==1129467728)throw Error("Unrecognized operations database");
    // Check the owned schema without scanning an arbitrarily large event store
    // on the application's startup path. SQLite validates pages as they are read.
    opened.prepare("SELECT id,body FROM current LIMIT 0").all();
    opened.prepare("SELECT seq,at,session,kind,task,family,project,body FROM events LIMIT 0").all();
    opened.prepare("SELECT key,value FROM metadata LIMIT 0").all();
    opened.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;");sessionId=randomUUID();return checkpoint();
  }catch(error){opened.close();db=undefined;throw error;}
}
function append(raw:unknown) {
  const delta=deltaSchema.parse(raw),connection=requireDB();connection.exec("BEGIN IMMEDIATE");
  try {
    if(delta.baseline){
      const previous=checkpoint();insert({at:delta.at,sessionId,kind:"session",changes:[],previousAt:previous.lastAt,gap:previous.lastAt!==undefined});
      // Changes across app downtime are observations, not reconstructed events.
      const present=new Set(delta.facts.map(f=>f.id));
      for(const row of connection.prepare("SELECT id,body FROM current").all())if(!present.has(String(row.id))){
        const previous=operationFactSchema.parse(JSON.parse(String(row.body)));
        insert({at:delta.at,sessionId,kind:"baseline",taskId:previous.id,title:previous.title,previous,changes:["missingAtStart"]});
        connection.prepare("DELETE FROM current WHERE id=?").run(previous.id);
      }
    }
    for(const current of delta.facts){
      const previousRow=connection.prepare("SELECT body FROM current WHERE id=?").get(current.id);
      const previous=previousRow?operationFactSchema.parse(JSON.parse(String(previousRow.body))):undefined;
      const changes=previous?[...new Set([...Object.keys(current),...Object.keys(previous)])].filter(key=>JSON.stringify(current[key as keyof OperationFact])!==JSON.stringify(previous[key as keyof OperationFact])):["added"];
      if(delta.baseline||changes.length)insert({at:delta.at,sessionId,kind:delta.baseline?"baseline":"changed",taskId:current.id,title:current.title,current,previous,changes});
      connection.prepare("INSERT INTO current(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(current.id,JSON.stringify(current));
    }
    for(const id of delta.removed){
      const row=connection.prepare("SELECT body FROM current WHERE id=?").get(id);if(!row)continue;
      const previous=operationFactSchema.parse(JSON.parse(String(row.body)));insert({at:delta.at,sessionId,kind:"removed",taskId:id,title:previous.title,previous,changes:["removed"]});connection.prepare("DELETE FROM current WHERE id=?").run(id);
    }
    if(delta.dispatch){
      const old=connection.prepare("SELECT value FROM metadata WHERE key='dispatch'").get();
      if(!old||String(old.value)!==JSON.stringify(delta.dispatch))insert({at:delta.at,sessionId,kind:"dispatch",changes:["dispatch"],dispatch:delta.dispatch});
      connection.prepare("INSERT INTO metadata(key,value) VALUES('dispatch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(delta.dispatch));
    }
    connection.exec("COMMIT");return checkpoint();
  }catch(error){connection.exec("ROLLBACK");throw error;}
}
function query(raw:unknown):OperationPage {
  const q=operationQuerySchema.parse(raw),connection=requireDB();
  const filter=createHash("sha256").update(JSON.stringify({taskId:q.taskId,familyId:q.familyId,projectKey:q.projectKey})).digest("hex");
  if(q.cursor&&q.cursor.filter!==filter)throw Error("History filter changed; start a new page");
  const ceiling=q.cursor?.ceiling??checkpoint().lastSeq;if(!ceiling)return {events:[]};
  const parts=["seq<=?"],values:(string|bigint|number)[]=[BigInt(ceiling)];
  if(q.cursor?.before){parts.push("seq<?");values.push(BigInt(q.cursor.before));}
  for(const [name,column] of [["taskId","task"],["familyId","family"],["projectKey","project"]] as const)if(q[name]){parts.push(`${column}=?`);values.push(q[name]!);}
  const statement=connection.prepare(`SELECT seq,body FROM events WHERE ${parts.join(" AND ")} ORDER BY seq DESC LIMIT ?`);statement.setReadBigInts(true);
  const rows=statement.all(...values,q.limit+1),more=rows.length>q.limit;
  const events=rows.slice(0,q.limit).map(row=>({...JSON.parse(String(row.body)),seq:String(row.seq)} as OperationEvent));
  return {events,ceiling,position:{before:q.cursor?.before,ceiling,filter},cursor:more?{before:events.at(-1)!.seq,ceiling,filter}:undefined};
}
port.on("message",(request:{id:number;method:string;args:unknown})=>{
  try{
    let value:unknown;
    switch(request.method){case "open":value=open(request.args);break;case "append":value=append(request.args);break;case "query":value=query(request.args);break;
      case "close":db?.close();db=undefined;port.postMessage({id:request.id,value:true});port.close();return;
      default:throw Error("Unknown operations history method");}
    port.postMessage({id:request.id,value});
  }catch(error){port.postMessage({id:request.id,error:error instanceof Error?error.message:"Operations history failed"});}
});
