import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,Download,FileText,LoaderCircle,Pencil,RefreshCw,Save,Upload} from 'lucide-react';
import {t,useI18n,errorText,formatDate} from './i18n';
import {MarkdownText} from './RichMessage';
import {clearMatchingEditorDraft,discardEditorDraft,editorDraftPersisted,fallbackCanonicalPath,readEditorDraft,saveEditorDraft,type FileEditorDraft} from './file-editor-drafts';
import './file-workspace.css';
type Call=(name:string,args?:unknown)=>Promise<any>;
async function prepare(value:any,cwd:string,file:string) {
  if(value.kind!=='text')return value;
  let hash=value.sha256;
  if(!hash){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.content));hash=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');}
  return {...value,sha256:hash,canonicalPath:value.canonicalPath||fallbackCanonicalPath(cwd,file)};
}
export function EditableFilePreview({cwd,file,call,close,jobId}:{cwd:string;file:string;call:Call;close:()=>void;jobId?:string}) {
  useI18n();
  const [data,setData]=useState<any>(),[text,setText]=useState(''),[edit,setEdit]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[draft,setDraft]=useState<FileEditorDraft>(),[storageFailed,setStorageFailed]=useState(false),[conflict,setConflict]=useState(false),[compare,setCompare]=useState(false),[reload,setReload]=useState(0);
  const generation=useRef(0),textRef=useRef(''),dataRef=useRef<any>(undefined);
  const dirty=!!data&&data.kind==='text'&&text!==data.content;
  useEffect(()=>{
    const request=++generation.current;let alive=true;
    setData(undefined);dataRef.current=undefined;setStorageFailed(false);setError('');setEdit(false);setDraft(undefined);setConflict(false);setCompare(false);setBusy(false);
    void call('chat.asset.read',{cwd,path:file,id:jobId}).then(value=>prepare(value,cwd,file)).then(value=>{
      if(!alive||request!==generation.current)return;
      setData(value);dataRef.current=value;setText(value.content);textRef.current=value.content;
      if(value.kind==='text'&&!value.readOnly){const saved=readEditorDraft(localStorage,value.canonicalPath);if(saved&&saved.text!==value.content){setDraft(saved);setStorageFailed(!editorDraftPersisted(value.canonicalPath));}else if(saved)try{discardEditorDraft(localStorage,value.canonicalPath);}catch{setStorageFailed(true);}}
    }).catch(reason=>{if(alive)setError(errorText(reason));});
    return()=>{alive=false;++generation.current;};
  },[cwd,file,jobId,reload]);
  useEffect(()=>{
    const before=(event:BeforeUnloadEvent)=>{if((dirty||draft)&&storageFailed){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);
  },[dirty,draft,storageFailed]);
  function change(value:string,base=dataRef.current){
    setText(value);textRef.current=value;
    if(!base||base.kind!=='text'||base.readOnly)return;
    try{
      if(value===base.content){discardEditorDraft(localStorage,base.canonicalPath);setStorageFailed(false);}
      else setStorageFailed(!saveEditorDraft(localStorage,{version:1,canonicalPath:base.canonicalPath,text:value,baseHash:base.sha256,updatedAt:Date.now()}));
    }catch{setStorageFailed(true);}
  }
  function discard(){if(!data)return;try{discardEditorDraft(localStorage,data.canonicalPath);setStorageFailed(false);setDraft(undefined);setConflict(false);setCompare(false);setError('');change(data.content);}catch(reason){setError(errorText(reason));}}
  function recover(){if(!draft||!data)return;const changed=draft.baseHash!==data.sha256;setEdit(true);setConflict(changed);setCompare(changed);change(draft.text);setDraft(undefined);}
  async function save(){
    if(!data||!dirty||busy||conflict)return;
    const request=generation.current,submitted=textRef.current,baseline=data;
    setBusy(true);setError('');
    try{
      const value=await prepare(await call('workspace.write',{cwd,path:file,text:submitted,mtime:baseline.mtime,expectedHash:baseline.sha256}),cwd,file);
      // A saved older draft must never remove newer typing or another file's draft.
      try{clearMatchingEditorDraft(localStorage,baseline.canonicalPath,submitted);}catch{if(request===generation.current)setStorageFailed(true);}
      if(request!==generation.current)return;
      setData(value);dataRef.current=value;
      if(textRef.current===submitted){setText(value.content);textRef.current=value.content;setStorageFailed(false);}
      else change(textRef.current,value);
    }catch(reason){if(request===generation.current){setError(errorText(reason));setConflict(true);}}
    finally{if(request===generation.current)setBusy(false);}
  }
  async function inspectDisk(){
    const request=generation.current;setBusy(true);setError('');
    try{const value=await prepare(await call('chat.asset.read',{cwd,path:file,id:jobId}),cwd,file);if(request!==generation.current)return;if(value.kind!=='text'||value.readOnly)throw Error(t('磁盘文件已不再是可编辑文本；草稿仍然保留。'));setData(value);dataRef.current=value;setCompare(true);setConflict(true);change(textRef.current,value);}
    catch(reason){if(request===generation.current)setError(errorText(reason));}finally{if(request===generation.current)setBusy(false);}
  }
  function downloadDraft(){const url=URL.createObjectURL(new Blob([draft?.text??textRef.current],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`${file.split(/[\\/]/).at(-1)||'file'}.draft.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <div className="file-preview editable-file-preview">
    <header><button aria-label={t('返回文件列表')} onClick={close}><ArrowLeft size={15}/></button><span title={file}>{file.split(/[\\/]/).at(-1)}{dirty?' •':''}</span>{data?.kind==='text'&&!data.readOnly&&<button disabled={!!draft} aria-label={edit?t('预览文件'):t('编辑文件')} title={draft?t('请先恢复或丢弃已有草稿'):edit?t('预览文件'):t('编辑文件')} onClick={()=>setEdit(v=>!v)}><Pencil size={14}/></button>}<button title={t('在默认应用中打开')} onClick={()=>void call('chat.asset.open',{cwd,path:file,id:jobId}).catch(reason=>setError(errorText(reason)))}><Upload size={14}/></button>{edit&&<button aria-label={t('保存文件')} title={t('保存文件')} disabled={busy||!dirty||conflict} onClick={()=>void save()}><Save size={14}/></button>}</header>
    {draft&&<section className="editor-draft-banner" role="status"><strong>{t('发现此文件的未保存草稿')}</strong><small>{formatDate(draft.updatedAt)}</small><p>{t(draft.baseHash===data?.sha256?'恢复前不会修改磁盘文件。':'磁盘内容已变化，恢复后请先对照当前版本。')}</p><button data-editor-recover onClick={recover}>{t('恢复草稿')}</button><button data-editor-discard onClick={discard}>{t('丢弃草稿')}</button></section>}
    {storageFailed&&<section className="editor-draft-banner editor-warning" role="alert"><p>{t('本地草稿无法持久保存，请下载副本后再关闭窗口。')}</p><button onClick={downloadDraft}><Download size={13}/>{t('下载草稿副本')}</button></section>}
    {error&&<section className="editor-draft-banner editor-warning" role="alert"><p>{error}</p>{data?.kind==='text'&&dirty?<button data-editor-inspect onClick={()=>void inspectDisk()} disabled={busy}><RefreshCw size={13}/>{t('重新读取磁盘版本并对照')}</button>:<button onClick={()=>setReload(v=>v+1)}><RefreshCw size={13}/>{t('重试')}</button>}</section>}
    {conflict&&data?.kind==='text'&&<section className="editor-draft-banner editor-warning"><p>{t('草稿与当前磁盘版本不同，请对照后决定。')}</p><button onClick={()=>setCompare(v=>!v)}>{t(compare?'隐藏磁盘版本':'对照磁盘版本')}</button><button data-editor-ack onClick={()=>{setConflict(false);setError('');}}>{t('已对照，允许保存当前草稿')}</button><button onClick={discard}>{t('使用磁盘版本并丢弃草稿')}</button></section>}
    {compare&&data?.kind==='text'&&<details className="editor-disk-comparison" open><summary>{t('当前磁盘版本（只读）')}</summary><pre>{data.content}</pre></details>}
    {!data?!error&&<div className="panel-loading"><LoaderCircle className="spin" size={20}/>{t('读取文件…')}</div>:data.kind==='image'?<div className="image-preview"><img src={data.content} alt={file}/></div>:data.kind==='pdf'?<div className="panel-empty"><FileText size={36}/><p>{t('PDF 文档 ·')}{(data.size/1024).toFixed(0)} KB</p><button onClick={()=>void call('chat.asset.open',{cwd,path:file,id:jobId})}>{t('在 PDF 阅读器中打开')}</button></div>:data.kind==='binary'||data.kind==='encoded'?<div className="panel-empty"><p>{t(data.kind==='binary'?'此文件使用二进制格式，请在默认应用中打开':'无法按 UTF-8 读取此文件，请在外部编辑器中打开以保留原始编码')}</p></div>:edit?<textarea className="file-editor" aria-label={t('编辑文件内容')} spellCheck={false} value={text} onChange={event=>change(event.target.value)} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!event.nativeEvent.isComposing){event.preventDefault();void save();}}}/>:/\.mdx?$/i.test(file)?<div className="file-markdown"><MarkdownText text={text}/></div>:<div className="source-preview"><pre>{text.split('\n').map((line,index)=><div key={index}><span>{index+1}</span><code>{line||' '}</code></div>)}</pre></div>}
    <footer>{data&&t('{p0}{p1} KB',{p0:data.kind==='text'?t('{p0} 行 · UTF-8 · ',{p0:text.split('\n').length}):'',p1:(data.size/1024).toFixed(1)})}{dirty&&<span className="editor-dirty-status">{t(storageFailed?'草稿仅在当前窗口保留':'未保存修改已保留为本地草稿')}</span>}</footer>
  </div>;
}
