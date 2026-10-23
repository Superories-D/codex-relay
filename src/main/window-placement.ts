import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../core/store";
export type Bounds = {x:number;y:number;width:number;height:number};
export function fitWindow(saved: unknown, displays: Bounds[]): Bounds & {maximized:boolean} {
  const fallback = displays[0] || {x:0,y:0,width:1280,height:860};
  const value = saved as any;
  const valid = value && ["x","y","width","height"].every(k=>Number.isFinite(value[k])) && value.width>0 && value.height>0;
  const area = valid ? displays.find(d=> value.x < d.x+d.width && value.x+value.width>d.x && value.y<d.y+d.height && value.y+value.height>d.y) || fallback : fallback;
  const width=Math.min(area.width,Math.max(600,valid?value.width:1280));
  const height=Math.min(area.height,Math.max(400,valid?value.height:860));
  return {width,height,x:Math.max(area.x,Math.min(valid?value.x:area.x+(area.width-width)/2,area.x+area.width-width)),y:Math.max(area.y,Math.min(valid?value.y:area.y+(area.height-height)/2,area.y+area.height-height)),maximized:valid && value.maximized===true};
}
export class WindowPlacement {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private root:string){}
  async read(displays:Bounds[]) {
    let saved:unknown;
    try { const file=path.join(this.root,"window-placement.json"); if((await fs.stat(file)).size<4096) saved=JSON.parse(await fs.readFile(file,"utf8")); } catch {}
    return fitWindow(saved,displays);
  }
  save(bounds:Bounds,maximized:boolean) {
    const text=JSON.stringify({...bounds,maximized});
    const task=this.chain.catch(()=>{}).then(()=>atomicWrite(path.join(this.root,"window-placement.json"),text));
    this.chain=task; return task;
  }
}
