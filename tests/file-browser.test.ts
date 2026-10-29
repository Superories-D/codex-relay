import {expect,it} from 'vitest';
import {browserBreadcrumbs,browserVisible,searchWorkspaceFiles,type FileEntry} from '../src/renderer/file-browser';
const file=(path:string,directory=false):FileEntry=>({path,name:path.split('/').at(-1)!,directory});
it('searches only the selected subtree and filters hidden segments without changing file paths',async()=>{
 const calls:string[]=[];const tree:Record<string,FileEntry[]>={'src':[file('src/ui',true),file('src/.private',true),file('src/index.ts')],'src/ui':[file('src/ui/Button.tsx')],'src/.private':[file('src/.private/Button.tsx')]};
 const result=await searchWorkspaceFiles({cwd:'C:/project',at:'src',query:'button',hidden:false,active:()=>true,list:async(_,at)=>{calls.push(at);return tree[at];}});
 expect(result.entries.map(e=>e.path)).toEqual(['src/ui/Button.tsx']);expect(calls).toEqual(['src','src/ui']);expect(result.incomplete).toBe(false);
 expect(browserVisible(file('.env'),false)).toBe(false);expect(browserVisible(file('src/.env'),true)).toBe(true);
});
it('bounds traversals, retains useful matches after unreadable directories and cancels stale requests',async()=>{
 const tree:Record<string,FileEntry[]>={'.':[file('a',true),file('b',true),file('c',true)],a:[file('a/match.txt')],c:[file('c/match.txt')]};
 const result=await searchWorkspaceFiles({cwd:'root',at:'.',query:'match',hidden:true,maxDirectories:3,active:()=>true,list:async(_,at)=>{if(at==='b')throw Error('denied');return tree[at];}});
 expect(result.entries.map(e=>e.path)).toEqual(['a/match.txt']);expect(result.errors).toBe(1);expect(result.incomplete).toBe(true);
 let active=true,count=0;
 const cancelled=await searchWorkspaceFiles({cwd:'root',at:'.',query:'match',hidden:true,active:()=>active,list:async()=>{count++;active=false;return [file('match')];}});
 expect(count).toBe(1);expect(cancelled.entries).toEqual([]);expect(cancelled.incomplete).toBe(true);
});
it('reports result and per-directory limits rather than presenting a partial search as exhaustive',async()=>{
 const result=await searchWorkspaceFiles({cwd:'root',at:'.',query:'file',hidden:true,maxResults:2,active:()=>true,list:async()=>[file('file1'),file('file2'),file('file3')]});
 expect(result.entries).toHaveLength(2);expect(result.incomplete).toBe(true);
 const capped=await searchWorkspaceFiles({cwd:'root',at:'.',query:'missing',hidden:true,active:()=>true,list:async()=>Array.from({length:1000},(_,i)=>file(`file${i}`))});expect(capped.incomplete).toBe(true);
});
it('builds clickable relative breadcrumbs for Windows separators',()=>{
 expect(browserBreadcrumbs('src\\renderer\\components')).toEqual([{name:'.',path:'.'},{name:'src',path:'src'},{name:'renderer',path:'src/renderer'},{name:'components',path:'src/renderer/components'}]);
});
