import type {TaskTemplate} from '../core/templates';
export interface TemplateLibrary {favorites: string[]; projects: Record<string,string[]>}
export const templateLibraryKey='relay.templateLibrary.v1';
export function templateProject(cwd:string){const normal=cwd.replace(/\\/g,'/').replace(/\/$/,'');return /^[A-Za-z]:[\\/]/.test(cwd)||cwd.startsWith('\\\\')?normal.toLowerCase():normal;}
export function readTemplateLibrary(raw:string|null):TemplateLibrary {
 try {const v=JSON.parse(raw||'{}');return {favorites:Array.isArray(v.favorites)?[...new Set(v.favorites.filter((id:unknown)=>typeof id==='string'&&id.length<=200))].slice(-100) as string[]:[],projects:v.projects&&typeof v.projects==='object'&&!Array.isArray(v.projects)?Object.fromEntries(Object.entries(v.projects).slice(-50).filter(([key,ids])=>key.length<=4000&&Array.isArray(ids)).map(([key,ids])=>[key,[...new Set((ids as unknown[]).filter((id): id is string=>typeof id==='string'&&id.length<=200))].slice(-100)])): {}};}catch{return {favorites:[],projects:{}};}
}
export function toggleTemplateLink(library:TemplateLibrary,id:string,project?:string):TemplateLibrary {
 const key=project?templateProject(project):undefined;
 const ids=key?library.projects[key]||[]:library.favorites;
 const next=ids.includes(id)?ids.filter(item=>item!==id):[...ids,id].slice(-100);
 return key?{...library,projects:{...library.projects,[key]:next}}:{...library,favorites:next};
}
export function filterTemplates(items:TaskTemplate[],library:TemplateLibrary,query:string,scope:'all'|'favorites'|'project',cwd:string,sort:'recent'|'name') {
 const term=query.trim().toLocaleLowerCase(),linked=new Set(library.projects[templateProject(cwd)]||[]);
 return items.filter(item=>(scope==='all'||(scope==='favorites'?library.favorites.includes(item.id):linked.has(item.id)))&&`${item.name} ${item.prompt} ${item.model}`.toLocaleLowerCase().includes(term)).sort((a,b)=>sort==='name'?a.name.localeCompare(b.name)||a.id.localeCompare(b.id):b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
}
export function sameTemplate(a:TaskTemplate,b:TaskTemplate){return JSON.stringify(a)===JSON.stringify(b);}
export function templateCloneName(name:string,suffix:string){return `${name.slice(0,Math.max(0,99-suffix.length))} ${suffix}`.slice(0,100);}
export function validTemplateLibrary(raw:string|null) {
 if(raw===null)return true;
 try{if(raw.length>1024*1024)return false;const value=JSON.parse(raw);
  const ids=(v:unknown)=>Array.isArray(v)&&v.length<=100&&v.every(id=>typeof id==='string'&&id.length<=200);
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>key==='favorites'||key==='projects')&&ids(value.favorites)&&!!value.projects&&typeof value.projects==='object'&&!Array.isArray(value.projects)&&Object.keys(value.projects).length<=50&&Object.entries(value.projects).every(([key,list])=>key.length<=4000&&ids(list));
 }catch{return false;}
}
