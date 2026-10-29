import {expect,it} from 'vitest';
import {homeJobs,projectShortName} from '../src/renderer/workspace-home';
import type {Job,Approval} from '../src/shared/types';
const job=(id:string,state:Job['state'],updatedAt:number,extra:Partial<Job>={})=>({id,state,updatedAt,...extra} as Job);
it('surfaces approval-blocked running jobs and manual attention without misclassifying automatic recovery',()=>{
 const jobs=[job('approval','running',10),job('attention','needs_attention',20),job('recover','needs_attention',30,{autoRecovery:{} as Job['autoRecovery']}),job('archived','needs_attention',50,{archived:true}),job('done','completed',40)];
 const view=homeJobs(jobs,[{jobId:'approval'} as Approval]);
 expect(view.attention.map(j=>j.id)).toEqual(['attention','approval']);
 expect(view.active.map(j=>j.id)).toEqual(['recover','approval']);
 expect(view.recent.map(j=>j.id)).toEqual(['done','recover','attention','approval']);
 expect(jobs[0].id).toBe('approval');
});
it('excludes incompatible imported history and supports both Windows and Linux project names',()=>{
 expect(homeJobs([job('broken','completed',1,{historySource:{issue:'missing source'} as Job['historySource']})],[]).recent).toEqual([]);
 expect(projectShortName('C:\\Users\\dev\\Project\\')).toBe('Project');
 expect(projectShortName('/workspace/project')).toBe('project');
});
