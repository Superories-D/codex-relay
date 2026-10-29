export interface FileEditorDraft { version:1; canonicalPath:string; text:string; baseHash:string; updatedAt:number }
const memory=new Map<string,FileEditorDraft>();
const failed=new Set<string>();
export const editorDraftPersisted=(canonicalPath:string)=>!failed.has(editorDraftKey(canonicalPath));
export function editorDraftKey(canonicalPath:string) { return `relay.fileEditor.v1:${canonicalPath}`; }
export function readEditorDraft(storage:Pick<Storage,'getItem'>,canonicalPath:string):FileEditorDraft|undefined {
  const key=editorDraftKey(canonicalPath);
  if(memory.has(key))return memory.get(key);
  try {
    const value=JSON.parse(storage.getItem(key)||'null');
    if(value?.version===1&&value.canonicalPath===canonicalPath&&typeof value.text==='string'&&/^[a-f0-9]{64}$/.test(value.baseHash)&&Number.isFinite(value.updatedAt))return value;
  } catch {}
}
export function saveEditorDraft(storage:Pick<Storage,'setItem'|'removeItem'>,draft:FileEditorDraft):boolean {
  const key=editorDraftKey(draft.canonicalPath);memory.set(key,draft);
  try{storage.setItem(key,JSON.stringify(draft));failed.delete(key);return true;}catch{failed.add(key);return false;}
}
export function discardEditorDraft(storage:Pick<Storage,'removeItem'>,canonicalPath:string) {
  const key=editorDraftKey(canonicalPath);storage.removeItem(key);memory.delete(key);failed.delete(key);
}
export function clearMatchingEditorDraft(storage:Pick<Storage,'getItem'|'removeItem'>,canonicalPath:string,savedText:string) {
  const current=readEditorDraft(storage,canonicalPath);
  if(current?.text===savedText)discardEditorDraft(storage,canonicalPath);
}
export function fallbackCanonicalPath(cwd:string,file:string) {
  return /^[a-z]:[\\/]|^[\\/]/i.test(file)?file.replace(/\\/g,'/'):`${cwd.replace(/[\\/]+$/,'')}/${file.replace(/\\/g,'/')}`;
}
