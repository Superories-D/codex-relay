export interface QueueEdit { base: string; text: string; updatedAt: number }
export type QueueEdits = Record<string, QueueEdit>;
export const queueEditKey = (jobId: string) => `relay.queueEdits.v1:${jobId}`;
export function readQueueEdits(raw: string | null): QueueEdits {
  try {
    const value = JSON.parse(raw || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, edit]: [string, any]) => id.length <= 200 && edit && typeof edit.base === 'string' && edit.base.length <= 100000 && typeof edit.text === 'string' && edit.text.length <= 100000 && Number.isFinite(edit.updatedAt)).slice(-50)) as QueueEdits;
  } catch { return {}; }
}
export function queueEditStatus(edit: QueueEdit, current: string | undefined): 'editing' | 'conflict' | 'removed' | 'saved' {
  if (current === undefined) return 'removed';
  if (current === edit.text) return 'saved';
  return current !== edit.base ? 'conflict' : 'editing';
}
export function setQueueEdit(edits: QueueEdits, id: string, current: string, text: string, now=Date.now()): QueueEdits {
  return {...edits,[id]:{base: edits[id]?.base ?? current,text,updatedAt:now}};
}
export function discardQueueEdit(edits: QueueEdits, id: string): QueueEdits {
  const next={...edits};delete next[id];return next;
}
export function validQueueEdits(raw:string|null){
 if(raw===null)return true;
 try{if(raw.length>12*1024*1024)return false;const value=JSON.parse(raw);return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).length<=50&&Object.entries(value).every(([id,edit]:[string,any])=>id.length<=200&&edit&&typeof edit==='object'&&Object.keys(edit).every(key=>['base','text','updatedAt'].includes(key))&&typeof edit.base==='string'&&edit.base.length<=100000&&typeof edit.text==='string'&&edit.text.length<=100000&&Number.isFinite(edit.updatedAt));}catch{return false;}
}
