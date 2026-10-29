import {expect,it} from 'vitest';
import {clearMatchingEditorDraft,discardEditorDraft,editorDraftKey,editorDraftPersisted,readEditorDraft,saveEditorDraft,type FileEditorDraft} from '../src/renderer/file-editor-drafts';
function storage(){const values=new Map<string,string>();return{getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
const draft=(path:string,text='unsaved'):FileEditorDraft=>({version:1,canonicalPath:path,text,baseHash:'a'.repeat(64),updatedAt:1});
it('isolates canonical files across workspaces and never clears newer typing after an older save resolves',()=>{
 const store=storage(),first=draft('/one/note.txt'),second=draft('/two/note.txt');
 saveEditorDraft(store,first);saveEditorDraft(store,second);saveEditorDraft(store,{...first,text:'newer'});
 clearMatchingEditorDraft(store,first.canonicalPath,'unsaved');
 expect(readEditorDraft(store,first.canonicalPath)?.text).toBe('newer');
 expect(readEditorDraft(store,second.canonicalPath)?.text).toBe('unsaved');
 clearMatchingEditorDraft(store,first.canonicalPath,'newer');expect(readEditorDraft(store,first.canonicalPath)).toBeUndefined();
});
it('retains a memory backup when persistent storage fails and reports failure until a successful retry',()=>{
 const store=storage(),value=draft('/failed/note.txt');
 expect(saveEditorDraft({...store,setItem:()=>{throw Error('quota');}},value)).toBe(false);
 expect(readEditorDraft(store,value.canonicalPath)).toEqual(value);expect(editorDraftPersisted(value.canonicalPath)).toBe(false);
 expect(saveEditorDraft(store,value)).toBe(true);expect(editorDraftPersisted(value.canonicalPath)).toBe(true);
 discardEditorDraft(store,value.canonicalPath);expect(readEditorDraft(store,value.canonicalPath)).toBeUndefined();
});
it('rejects corrupt or mismatched persisted drafts without executing data',()=>{
 const store=storage(),path='/invalid/note.txt',key=editorDraftKey(path);
 for(const value of ['{',JSON.stringify({...draft(path),baseHash:'wrong'}),JSON.stringify(draft('/wrong/file')),JSON.stringify({...draft(path),updatedAt:null})]){
  store.setItem(key,value);expect(readEditorDraft(store,path)).toBeUndefined();
 }
});

it('recovers persisted large drafts even when they must be reduced before the disk size limit permits saving',()=>{
 const store=storage(),value=draft('/large/note.txt','x'.repeat(2*1024*1024+1));
 store.setItem(editorDraftKey(value.canonicalPath),JSON.stringify(value));
 expect(readEditorDraft(store,value.canonicalPath)?.text).toBe(value.text);
});
