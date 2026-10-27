import React,{useEffect,useMemo,useRef,useState} from "react";
import type {ProjectChanges} from "../project-git";
import {gitStaged,gitUnstaged} from "../../shared/git";
import {Dialog} from "../../renderer/Dialog";
import {CopyButton} from "../../renderer/CopyButton";
import {t,errorText,formatDate} from "../../renderer/i18n";

type DiffRequest={cwd:string;path:string;staged:boolean};
type DiffView={request:DiffRequest;result?:{root:string;branch:string;at:number;text:string};error?:string};
function DiffText({text}:{text:string}) {
  const pages=useMemo(()=>{
    const pages:string[]=[];let start=0;
    while(start<text.length){let end=Math.min(text.length,start+20000);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;const newline=text.lastIndexOf("\n",end-1);if(end<text.length&&newline>start+10000)end=newline+1;pages.push(text.slice(start,end));start=end;}
    return pages.length?pages:[""];
  },[text]);
  const [page,setPage]=useState(0),content=useRef<HTMLPreElement>(null);
  useEffect(()=>{if(content.current)content.current.scrollTop=0;},[page]);
  return <>
    {pages.length>1&&<div className="row remote-git-pages"><button type="button" aria-label={t("上一页差异")} disabled={!page} onClick={()=>setPage(page-1)}>{t("上一页")}</button><span aria-live="polite">{page+1}/{pages.length}</span><button type="button" aria-label={t("下一页差异")} disabled={page+1>=pages.length} onClick={()=>setPage(page+1)}>{t("下一页")}</button><small>{t("分页显示，复制包含完整差异。")}</small></div>}
    <pre ref={content} tabIndex={0}>{pages[Math.min(page,pages.length-1)]||t("当前内容无差异。")}</pre>
  </>;
}
export function RemoteRepository({roots,cwd,call}:{roots:string[];cwd:string;call:(name:string,args?:any,signal?:AbortSignal)=>Promise<any>}) {
  const [project,setProject]=useState(cwd||roots[0]||""),[view,setView]=useState<ProjectChanges>(),[error,setError]=useState(""),[loading,setLoading]=useState(false),[query,setQuery]=useState(""),[page,setPage]=useState(0),[diff,setDiff]=useState<DiffView>(),[diffLoading,setDiffLoading]=useState(false);
  const alive=useRef(true),listEpoch=useRef(0),diffEpoch=useRef(0),listRequest=useRef<AbortController|undefined>(undefined),diffRequest=useRef<AbortController|undefined>(undefined);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;listRequest.current?.abort();diffRequest.current?.abort();};},[]);
  const closeDiff=()=>{diffEpoch.current++;diffRequest.current?.abort();setDiff(undefined);setDiffLoading(false);};
  const reset=()=>{listEpoch.current++;listRequest.current?.abort();listRequest.current=undefined;setView(undefined);setLoading(false);setError("");setPage(0);setQuery("");closeDiff();};
  async function load() {
    if(listRequest.current)return;
    const epoch=++listEpoch.current,controller=new AbortController();listRequest.current=controller;setLoading(true);setError("");closeDiff();
    try {
      const next=await call("project.changes",{cwd:project.trim()},controller.signal);
      if(alive.current&&epoch===listEpoch.current){setView(next);setPage(0);}
    }catch(error){if(alive.current&&epoch===listEpoch.current)setError(errorText(error));}
    finally{if(listRequest.current===controller)listRequest.current=undefined;if(alive.current&&epoch===listEpoch.current)setLoading(false);}
  }
  async function openDiff(request:DiffRequest) {
    const epoch=++diffEpoch.current,controller=new AbortController();diffRequest.current?.abort();diffRequest.current=controller;setDiff({request});setDiffLoading(true);
    try {
      const result=await call("project.diff",request,controller.signal);
      if(alive.current&&epoch===diffEpoch.current)setDiff({request,result});
    }catch(error){if(alive.current&&epoch===diffEpoch.current)setDiff({request,error:errorText(error)});}
    finally{if(alive.current&&epoch===diffEpoch.current)setDiffLoading(false);}
  }
  const files=(view?.files||[]).filter(file=>`${file.path} ${file.original||""}`.toLowerCase().includes(query.toLowerCase())),pages=Math.max(1,Math.ceil(files.length/20)),current=Math.min(page,pages-1);
  return <details className="remote-repository">
    <summary>{t("项目 Git")}</summary>
    <form onSubmit={event=>{event.preventDefault();void load();}}>
      <label>{t("工作目录")}<input list="remote-git-roots" value={project} onChange={event=>{setProject(event.target.value);reset();}} required maxLength={32767}/></label>
      <datalist id="remote-git-roots">{roots.map(root=><option key={root} value={root}/>)}</datalist>
      <button disabled={loading||!project.trim()}>{t("读取项目变更")}</button>
    </form>
    <p className="muted">{t("只读检查；自定义过滤器已禁用，子模块内容不展开。")}</p>
    {loading&&<p role="status">{t("正在读取项目变更…")}</p>}
    {error&&<p role="alert">{error}</p>}
    {view&&<>
      <p><strong>{view.branch}</strong> · <code>{view.head.slice(0,12)}</code></p><p className="muted">{view.root}<br/>{t("读取于")} {formatDate(view.at)}</p>
      {view.truncated&&<p>{t("仅展示前 500 项变更。")}</p>}
      <input aria-label={t("按文件名筛选")} placeholder={t("按文件名筛选")} value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/>
      {!files.length&&<p>{t(view.files.length?"未找到匹配文件。":"未检测到文件变更。")}</p>}
      <ol className="remote-git-files" start={current*20+1}>{files.slice(current*20,current*20+20).map((file,index)=><li key={`${file.path}-${file.index}-${index}`}>
        <code>{file.path}</code>{file.original&&<small>← {file.original}</small>}
        {file.directory?<small>{t("目录")}</small>:<div className="row">
          {gitStaged(file)&&<button type="button" disabled={loading} onClick={()=>void openDiff({cwd:view.root,path:file.path,staged:true})}>{t("暂存区差异")}</button>}
          {gitUnstaged(file)&&<button type="button" disabled={loading} onClick={()=>void openDiff({cwd:view.root,path:file.path,staged:false})}>{t("工作区差异")}</button>}
        </div>}
      </li>)}</ol>
      <div className="row"><button type="button" disabled={!current} onClick={()=>setPage(current-1)}>{t("上一页")}</button><span>{current+1}/{pages} · {files.length}/{view.total}</span><button type="button" disabled={current+1>=pages} onClick={()=>setPage(current+1)}>{t("下一页")}</button></div>
    </>}
    {diff&&<Dialog title={t(diff.request.staged?"暂存区差异":"工作区差异")} onClose={closeDiff}>
      <div className="remote-git-diff"><h2>{t(diff.request.staged?"暂存区差异":"工作区差异")}</h2><code>{diff.request.path}</code>
        {diffLoading&&<p role="status">{t("读取差异中…")}</p>}{diff.error&&<p role="alert">{diff.error}</p>}
        {diff.result&&<><p className="muted">{diff.result.root}<br/>{diff.result.branch} · {formatDate(diff.result.at)}</p><CopyButton text={diff.result.text} label={t("复制差异")}/><DiffText text={diff.result.text}/></>}
        <button type="button" disabled={diffLoading} onClick={()=>void openDiff(diff.request)}>{t("重新读取差异")}</button>
      </div>
    </Dialog>}
  </details>;
}
