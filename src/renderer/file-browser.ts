export interface FileEntry { name: string; path: string; directory: boolean }
export interface FileSearchResult { entries: FileEntry[]; scanned: number; incomplete: boolean; errors: number }
export function normalizeBrowserPath(value: string) { return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.'; }
export function browserBreadcrumbs(value: string) {
  const parts=normalizeBrowserPath(value).split('/').filter(part=>part&&part!=='.');
  return [{name:'.',path:'.'},...parts.map((name,index)=>({name,path:parts.slice(0,index+1).join('/')}))];
}
export const browserVisible = (entry: FileEntry, hidden: boolean) => hidden || !entry.path.split(/[\\/]/).some(part=>part.startsWith('.') && part!=='.');
export async function searchWorkspaceFiles(options: {
  cwd:string; at:string; query:string; hidden:boolean;
  list:(cwd:string,at:string)=>Promise<FileEntry[]>; active:()=>boolean;
  maxDirectories?:number;maxResults?:number;
}):Promise<FileSearchResult> {
  const queue=[normalizeBrowserPath(options.at)], seen=new Set<string>(), entries:FileEntry[]=[];
  const query=options.query.trim().toLocaleLowerCase(), maxDirectories=options.maxDirectories??150, maxResults=options.maxResults??200;
  let scanned=0,errors=0,incomplete=false;
  while(queue.length&&options.active()) {
    const at=queue.shift()!;
    if(seen.has(at))continue;
    if(scanned>=maxDirectories){incomplete=true;break;}
    seen.add(at);scanned++;
    let items:FileEntry[];
    try{items=await options.list(options.cwd,at);}catch{errors++;continue;}
    if(!options.active())break;
    if(items.length>=1000)incomplete=true; // Existing workspace.files intentionally bounds a directory.
    for(const entry of items) {
      if(!browserVisible(entry,options.hidden))continue;
      if(entry.path.toLocaleLowerCase().includes(query))entries.push(entry);
      if(entry.directory)queue.push(entry.path);
      if(entries.length>=maxResults){incomplete=true;break;}
    }
    if(entries.length>=maxResults)break;
  }
  return {entries,scanned,incomplete:incomplete||!options.active(),errors};
}
