import {promises as fs} from "node:fs";
import path from "node:path";
import {z} from "zod";
const port=z.number().int().min(0).max(65535);
const schema=z.object({version:z.literal(1),dataDir:z.string().min(1).max(32700).optional(),cli:z.string().min(1).max(32700).optional(),httpPort:port.optional(),ipcPort:port.optional(),workspaces:z.array(z.string().min(1).max(32700)).max(100).default([]),telegram:z.boolean().default(false)}).strict();
export async function readServerConfig(file?:string) {
  if(!file)return undefined;
  const absolute=path.resolve(file),stat=await fs.stat(absolute);
  if(!stat.isFile()||stat.size>65536)throw Error("Server config must be a JSON file no larger than 64 KiB");
  const config=schema.parse(JSON.parse(await fs.readFile(absolute,"utf8"))),base=path.dirname(absolute);
  return {...config,dataDir:config.dataDir?path.resolve(base,config.dataDir):undefined,workspaces:config.workspaces.map(p=>path.resolve(base,p)),cli:config.cli?.includes(path.sep)?path.resolve(base,config.cli):config.cli};
}
