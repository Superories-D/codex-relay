import {expect,it} from 'vitest';
import type {TaskTemplate} from '../src/core/templates';
import {filterTemplates,readTemplateLibrary,sameTemplate,templateCloneName,toggleTemplateLink,validTemplateLibrary} from '../src/renderer/template-library';
const item=(id:string,name:string,prompt:string,updatedAt:number):TaskTemplate=>({id,name,prompt,updatedAt,model:'codex',effort:'high',planMode:false,multiAgent:true});
it('persists independent favorites and project links and searches real instructions with stable ordering',()=>{
 const a=item('a','Tests','Verify payment workflow',1),b=item('b','Review','Inspect permissions',3);
 let lib=toggleTemplateLink({favorites:[],projects:{}},a.id);
 lib=toggleTemplateLink(lib,b.id,'C:\\Projects\\App\\');
 expect(readTemplateLibrary(JSON.stringify(lib))).toEqual(lib);
 expect(filterTemplates([a,b],lib,'payment','all','', 'recent').map(i=>i.id)).toEqual(['a']);
 expect(filterTemplates([a,b],lib,'','project','c:/Projects/App','recent').map(i=>i.id)).toEqual(['b']);
 expect(filterTemplates([a,b],lib,'','favorites','', 'recent').map(i=>i.id)).toEqual(['a']);
 expect(filterTemplates([a,b],lib,'','all','', 'recent').map(i=>i.id)).toEqual(['b','a']);
 expect(lib.projects['c:/projects/app']).toEqual(['b']);
});
it('detects changed delivery criteria before preview insertion and never mutates source templates when cloning',()=>{
 const a={...item('a','A','Prompt',1),deliveryChecks:[]};
 expect(sameTemplate(a,structuredClone(a))).toBe(true);
 expect(sameTemplate(a,{...a,prompt:'remote edit'})).toBe(false);
 const copied={...a,name:templateCloneName(a.name,'copy')};
 expect(copied.name).toBe('A copy');expect(a.name).toBe('A');
 expect(templateCloneName('x'.repeat(100),'copy')).toHaveLength(100);
 expect(readTemplateLibrary('null')).toEqual({favorites:[],projects:{}});
});

it('refuses to overwrite malformed or unknown favorite metadata automatically',()=>{
 expect(validTemplateLibrary(null)).toBe(true);
 expect(validTemplateLibrary(JSON.stringify({favorites:['one'],projects:{'/workspace':['one']}}))).toBe(true);
 for(const raw of ['null','{bad',JSON.stringify({favorites:[],projects:{},futureSettings:true}),JSON.stringify({favorites:[1],projects:{}})])expect(validTemplateLibrary(raw)).toBe(false);
});
