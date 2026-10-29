import React,{useEffect,useRef,useState} from 'react';
import {History,Copy,Save,Trash2} from 'lucide-react';
import type {ChatAttachment} from '../shared/types';
import {Dialog} from './Dialog';
import {draftHistoryKey,captureDraft,clearDraftHistory,readDraftHistory,sameDraft,type DraftVersion} from './draft-history';
import {t,formatDate,errorText} from './i18n';
import './draft-history.css';
export function DraftHistory({scope,text,files,disabled,restore}:{scope:string;text:string;files:ChatAttachment[];disabled:boolean;restore:(text:string,files:ChatAttachment[])=>void}) {
 const [open,setOpen]=useState(false),[selected,setSelected]=useState<DraftVersion>(),[data,setData]=useState(()=>readDraftHistory(localStorage)),[error,setError]=useState(''),[backupConfirmed,setBackupConfirmed]=useState(false);
 const opening=useRef({text,files});
 const latest=useRef({scope,text,files}),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),cleared=useRef<string|undefined>(undefined);
 latest.current={scope,text,files};
 const signature=JSON.stringify({text,files});
 const capture=(force=true)=>{if(!force&&cleared.current===signature)return;try{if(force)cleared.current=undefined;captureDraft(localStorage,scope,text,files);setData(readDraftHistory(localStorage));setError('');}catch(e){setError(errorText(e));}};
 useEffect(()=>{timer.current=setTimeout(()=>capture(false),1500);return()=>clearTimeout(timer.current);},[scope,text,JSON.stringify(files)]);
 useEffect(()=>()=>{const v=latest.current;if(cleared.current===JSON.stringify({text:v.text,files:v.files}))return;try{captureDraft(localStorage,v.scope,v.text,v.files);}catch{}},[]);
 const versions=data.entries.filter(v=>v.scope===scope);
 return <><button type="button" className="draft-history-trigger" data-testid="draft-history" title={t('草稿历史')} onClick={()=>{capture(false);opening.current=structuredClone({text,files});setSelected(undefined);setOpen(true);}}><History size={14}/>{t('草稿历史')}{versions.length>0&&<small>{versions.length}</small>}</button>
 {error&&!open&&<span className="draft-history-warning" role="status">{t('草稿历史未保存，当前输入仍保留')}</span>}
 {open&&<Dialog title={t('草稿历史')} onClose={()=>setOpen(false)}><section className="draft-history"><h2>{t('草稿历史')}</h2><p>{t('查看最近版本，选择后可恢复到当前输入框。不会自动发送。')}</p><small>{t('每个输入框保留最近 12 版，全部最多 40 版。')}</small>{(error||data.blocked)&&<p role="alert">{error||t('草稿历史无法读取，原记录已保留')}</p>}
 <div className="draft-history-toolbar"><button onClick={()=>capture()} disabled={disabled||data.blocked}><Save size={14}/>{t('保存当前版本')}</button><button onClick={()=>{const blob=new Blob([data.raw],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='draft-history.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);}} disabled={!data.raw}>{t('导出草稿历史')}</button></div>
 {data.blocked&&<div className="draft-history-repair"><label><input type="checkbox" checked={backupConfirmed} onChange={e=>setBackupConfirmed(e.target.checked)}/>{t('已导出需要保留的历史记录')}</label><button disabled={!backupConfirmed} onClick={()=>{try{localStorage.setItem(draftHistoryKey,JSON.stringify({version:1,entries:[]}));setData(readDraftHistory(localStorage));setError('');setBackupConfirmed(false);}catch(e){setError(errorText(e));}}}>{t('重建空白历史')}</button></div>}<div className="draft-history-body"><div className="draft-history-list">{versions.map(v=><button key={v.id} aria-pressed={selected?.id===v.id} onClick={()=>{setSelected(v);opening.current=structuredClone({text,files});}}><strong>{formatDate(v.at)}</strong><span>{v.text.slice(0,90)||t('仅附件草稿')}</span><small>{t('{count} 个附件',{count:v.files.length})}</small></button>)}{!versions.length&&<p>{t('还没有保存的草稿版本')}</p>}</div><div className="draft-history-preview">{selected?<><textarea readOnly aria-label={t('草稿版本预览')} value={selected.text}/>{selected.files.map((f,i)=><p key={i} title={f.path}>{f.name}</p>)}<button data-testid="draft-restore" disabled={disabled||data.blocked||!sameDraft(opening.current,{text,files})} onClick={()=>{try{captureDraft(localStorage,scope,text,files);restore(selected.text,structuredClone(selected.files));setOpen(false);}catch(e){setError(errorText(e));}}}>{t('替换当前草稿')}</button>{!sameDraft(opening.current,{text,files})&&<p role="status">{t('输入内容已变化，请重新选择版本后恢复')}</p>}</>:<p>{t('选择一个版本查看内容')}</p>}</div></div>
 <button className="draft-history-clear" disabled={data.blocked||!versions.length} onClick={()=>{try{clearTimeout(timer.current);clearDraftHistory(localStorage,scope);cleared.current=signature;setData(readDraftHistory(localStorage));setSelected(undefined);}catch(e){setError(errorText(e));}}}><Trash2 size={13}/>{t('清空此输入框历史')}</button></section></Dialog>}</>;
}
