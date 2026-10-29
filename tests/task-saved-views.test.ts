import {expect,it} from 'vitest';
import {loadSavedTaskViews,writeSavedTaskView,sameTaskCriteria,type SavedTaskView} from '../src/shared/task-saved-views';
const view=(name='Release',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'):SavedTaskView=>({id,name,query:'release',project:'D:\\项目',filter:'attention',sort:'recent',layout:'board'});
it('round-trips the entire named view without changing project paths or criteria',()=>{
 const saved=writeSavedTaskView([],view());
 expect(loadSavedTaskViews(JSON.stringify(saved))).toEqual({views:saved,invalid:false});
 expect(sameTaskCriteria(saved[0],{...saved[0],query:'other'})).toBe(false);
 expect(sameTaskCriteria(saved[0],view())).toBe(true);
});
it('renames and replaces by identity, rejects ambiguous duplicate names and caps saved views',()=>{
 const initial=[view()];const renamed=writeSavedTaskView(initial,{...view(),name:'Review'});
 expect(renamed).toHaveLength(1);expect(renamed[0].name).toBe('Review');expect(initial[0].name).toBe('Release');
 expect(()=>writeSavedTaskView(initial,view('release','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))).toThrow('同名');
 const full=Array.from({length:20},(_,i)=>view(String(i),`${String(i).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`));
 expect(()=>writeSavedTaskView(full,view())).toThrow('20');
});
it('treats malformed, oversized or duplicate storage as corrupt rather than silently resetting it',()=>{
 for(const raw of ['{','{}',JSON.stringify([{...view(),layout:'grid'}]),JSON.stringify([view(),view()])])expect(loadSavedTaskViews(raw)).toEqual({views:[],invalid:true});
 expect(loadSavedTaskViews(null)).toEqual({views:[],invalid:false});
});
