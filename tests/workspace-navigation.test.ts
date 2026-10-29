import {expect,it} from 'vitest';
import {recordWorkspaceRoute,workspaceHistoryTarget,type WorkspaceNavigation,type WorkspaceRoute} from '../src/renderer/workspace-navigation';
const route=(jobId?:string,cwd='C:/project',screen='chat'):WorkspaceRoute=>({jobId,cwd,screen,manage:''});
it('restores previous routes without duplicating them and branches after back navigation',()=>{
 let nav:WorkspaceNavigation={entries:[],index:-1};
 for(const r of [route(),route('a'),route('b')])nav=recordWorkspaceRoute(nav,r);
 nav={...nav,index:1};
 expect(recordWorkspaceRoute(nav,route('a'))).toBe(nav);
 nav=recordWorkspaceRoute(nav,route('c'));
 expect(nav.entries.map(r=>r.jobId)).toEqual([undefined,'a','c']);
 expect(workspaceHistoryTarget(nav,1,new Set(['a','b','c']))).toBe(-1);
});
it('distinguishes project drafts and screens, skips deleted chats, bounds navigation memory',()=>{
 let nav:WorkspaceNavigation={entries:[],index:-1};
 for(const r of [route(undefined,'C:/first'),route('deleted'),route(undefined,'C:/other'),route(undefined,'C:/other','tasks')])nav=recordWorkspaceRoute(nav,r);
 expect(nav.entries).toHaveLength(4);
 expect(workspaceHistoryTarget({...nav,index:2},-1,new Set())).toBe(0);
 for(let i=0;i<70;i++)nav=recordWorkspaceRoute(nav,route(String(i)));
 expect(nav.entries).toHaveLength(50);expect(nav.index).toBe(49);
});
