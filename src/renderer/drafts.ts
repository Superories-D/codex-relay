import type { ChatAttachment } from "../shared/types";
export interface DraftState {
  drafts: Record<string, string>;
  files: Record<string, ChatAttachment[]>;
}
const storageKey = "relay.composer.v2";
function validFiles(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (a): a is ChatAttachment =>
        !!a &&
        ["localImage", "mention"].includes(a.type) &&
        typeof a.path === "string" &&
        a.path.length <= 32700 &&
        typeof a.name === "string" &&
        a.name.length <= 300,
    )
    .slice(0, 20);
}
export function loadDraftState(storage: Pick<Storage, "getItem">): DraftState {
  const result: DraftState = { drafts: {}, files: {} };
  try {
    const saved = storage.getItem(storageKey);
    const parsed = JSON.parse(saved || "null");
    const legacy = saved
      ? null
      : JSON.parse(storage.getItem("relay.drafts") || "{}");
    const drafts = parsed?.version === 2 ? parsed.drafts : legacy;
    if (drafts && typeof drafts === "object" && !Array.isArray(drafts))
      for (const [key, value] of Object.entries(drafts))
        if (typeof value === "string" && value.length <= 100000)
          Object.defineProperty(
            result.drafts,
            key === "new"
              ? `new:${storage.getItem("relay.project") || ""}`
              : key,
            { value, enumerable: true, configurable: true, writable: true },
          );
    if (
      parsed?.version === 2 &&
      parsed.files &&
      typeof parsed.files === "object"
    )
      for (const [key, value] of Object.entries(parsed.files))
        Object.defineProperty(result.files, key, {
          value: validFiles(value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
  } catch {
    /* Corrupt local drafts must not prevent the app from opening. */
  }
  return result;
}
export function saveDraftState(
  storage: Pick<Storage, "setItem"> & Partial<Pick<Storage,"getItem">>,
  state: DraftState,
) {
  writeDraftState(storage,state,confirmations(storage));
}
function confirmations(storage:Partial<Pick<Storage,"getItem">>):Record<string,string>{
  try{
    const saved=JSON.parse(storage.getItem?.(storageKey)||"null"),values=saved?.nativeConfirmations;
    if(values&&typeof values==="object"&&!Array.isArray(values))return Object.fromEntries(Object.entries(values).filter(([key,value])=>typeof value==="string"&&key.length<=200&&value.length<=100).slice(-500)) as Record<string,string>;
  }catch{}
  return {};
}
function writeDraftState(storage:Pick<Storage,"setItem">,state:DraftState,confirmed:Record<string,string>){
  const drafts = Object.fromEntries(
    Object.entries(state.drafts).filter(([, text]) => text.length),
  );
  const files = Object.fromEntries(
    Object.entries(state.files).filter(([, values]) => values.length),
  );
  const content = JSON.stringify({ version: 2, drafts, files,...(Object.keys(confirmed).length?{nativeConfirmations:confirmed}:{}) });
  if (content.length > 4 * 1024 * 1024) throw Error("Draft storage is full");
  storage.setItem(storageKey, content);
}
export function confirmNativeDraft(storage:Pick<Storage,"getItem"|"setItem">,current:DraftState,requestId:string,key:string,text:string,attachments:ChatAttachment[]):DraftState {
  const confirmed=confirmations(storage);if(confirmed[key]===requestId)return current;
  const remaining=[...attachments],files=(current.files[key]||[]).filter(file=>{
    const index=remaining.findIndex(old=>old.path===file.path&&old.name===file.name&&old.type===file.type);
    if(index<0)return true;remaining.splice(index,1);return false;
  });
  const next={drafts:{...current.drafts,[key]:remainingDraft(current.drafts[key]||"",text)},files:{...current.files,[key]:files}};
  delete confirmed[key];confirmed[key]=requestId;
  writeDraftState(storage,next,Object.fromEntries(Object.entries(confirmed).slice(-500)));
  return next;
}
// A successful request owns only the exact draft/attachments it submitted.
export function remainingDraft(current: string, submitted: string) {
  return current === submitted ? "" : current;
}
export function remainingFiles(
  current: ChatAttachment[],
  submitted: ChatAttachment[],
) {
  return current.filter((file) => !submitted.includes(file));
}
