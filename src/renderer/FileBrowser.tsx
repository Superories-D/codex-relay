import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,ChevronRight,Eye,EyeOff,FileCode2,Folder,FolderOpen,LoaderCircle,RefreshCw,Search,X} from 'lucide-react';
import {t,useI18n,errorText} from './i18n';
import {browserBreadcrumbs,browserVisible,normalizeBrowserPath,readBrowserLocation,searchWorkspaceFiles,type FileEntry,type FileSearchResult} from './file-browser';
import './file-workspace.css';
type Call=(name:string,args?:unknown)=>Promise<any>;
export function FileBrowser({cwd,call,select}:{cwd:string;call:Call;select:(path:string)=>void}) {
  useI18n();
  const [at,setAt]=useState(()=>readBrowserLocation(localStorage,cwd)),[query,setQuery]=useState(''),[hidden,setHidden]=useState(()=>localStorage.getItem('relay.files.hidden')==='true');
  const [entries,setEntries]=useState<FileEntry[]>([]),[search,setSearch]=useState<FileSearchResult>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),[reload,setReload]=useState(0),[focused,setFocused]=useState(0),[limit,setLimit]=useState(150);
  const list=useRef<HTMLDivElement>(null),generation=useRef(0);
  useEffect(()=>{try{localStorage.setItem(`relay.files.at:${cwd}`,at);}catch{}},[cwd,at]);
  useEffect(()=>{try{localStorage.setItem('relay.files.hidden',String(hidden));}catch{}},[hidden]);
  useEffect(()=>{
    const request=++generation.current;let alive=true;
    setLoading(true);setError('');setSearch(undefined);setFocused(0);setLimit(150);
    const timer=setTimeout(()=>{
      const active=()=>alive&&request===generation.current;
      const operation=query.trim()?searchWorkspaceFiles({cwd,at,query,hidden,list:(cwd,path)=>call('workspace.files',{cwd,path}),active}):call('workspace.files',{cwd,path:at}).then((result:FileEntry[])=>({entries:result.filter(e=>browserVisible(e,hidden)),scanned:1,incomplete:result.length>=1000,errors:0}));
      void operation.then(result=>{if(active()){setEntries(result.entries);if(query.trim()||result.incomplete)setSearch(result);}}).catch(reason=>{if(active())setError(errorText(reason));}).finally(()=>{if(active())setLoading(false);});
    },query.trim()?220:0);
    return()=>{alive=false;clearTimeout(timer);};
  },[cwd,at,query,hidden,reload]);
  const crumbs=browserBreadcrumbs(at),shown=entries.slice(0,limit);
  function open(entry:FileEntry){if(entry.directory){setAt(normalizeBrowserPath(entry.path));setQuery('');}else select(entry.path);}
  function focus(index:number){const next=Math.max(0,Math.min(shown.length-1,index));setFocused(next);list.current?.querySelectorAll<HTMLButtonElement>('[data-file-entry]')[next]?.focus();}
  return <section className="file-browser" aria-label={t('项目文件浏览器')}>
    <div className="file-browser-tools"><label><Search size={15}/><input aria-label={t('搜索当前目录及子目录')} placeholder={t('搜索当前目录及子目录')} value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button aria-label={t('清除文件搜索')} onClick={()=>setQuery('')}><X size={14}/></button>}</label><button aria-label={hidden?t('隐藏点文件'):t('显示点文件')} title={hidden?t('隐藏点文件'):t('显示点文件')} aria-pressed={hidden} onClick={()=>setHidden(v=>!v)}>{hidden?<Eye size={15}/>:<EyeOff size={15}/>}</button><button aria-label={t('刷新文件列表')} title={t('刷新文件列表')} onClick={()=>setReload(v=>v+1)}><RefreshCw size={15}/></button></div>
    <nav className="file-browser-crumbs" aria-label={t('目录路径')}>{crumbs.map((crumb,index)=><React.Fragment key={crumb.path}>{index>0&&<ChevronRight size={11}/>}<button aria-current={index===crumbs.length-1?'location':undefined} title={index===0?cwd:crumb.path} onClick={()=>{setAt(crumb.path);setQuery('');}}>{index===0?<FolderOpen size={14}/>:crumb.name}</button></React.Fragment>)}</nav>
    <div className="file-browser-scope"><span>{query.trim()?t('递归搜索文件名与相对路径'):t('方向键浏览 · Enter 打开 · Backspace 上一级')}</span>{loading&&<LoaderCircle size={14} className="spin"/>}</div>
    {search&&(search.incomplete||search.errors>0)&&<p role="status" className="file-browser-notice">{t('已检查 {count} 个目录；结果可能不完整。',{count:search.scanned})}{search.errors>0&&t(' {count} 个目录无法读取。',{count:search.errors})}</p>}
    {error&&<p className="panel-error" role="alert">{error}</p>}
    <div className="file-browser-list" ref={list} role="list" aria-label={t('文件与目录')} aria-busy={loading} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();focus(focused+(event.key==='ArrowDown'?1:-1));}else if(event.key==='Home'||event.key==='End'){event.preventDefault();focus(event.key==='Home'?0:shown.length-1);}else if(event.key==='Backspace'||event.key==='ArrowLeft'){event.preventDefault();if(at!=='.'){setAt(crumbs.at(-2)?.path||'.');setQuery('');}}else if(event.key==='ArrowRight'&&shown[focused]?.directory){event.preventDefault();open(shown[focused]);}}}>
      {at!=='.'&&!query.trim()&&<button className="file-browser-up" onClick={()=>{setAt(crumbs.at(-2)?.path||'.');setQuery('');}}><ArrowLeft size={14}/>{t('上一级目录')}</button>}
      {shown.map((entry,index)=><div role="listitem" key={entry.path}><button data-file-entry tabIndex={focused===index?0:-1} title={entry.path} onFocus={()=>setFocused(index)} onClick={()=>open(entry)}>{entry.directory?<Folder size={16}/>:<FileCode2 size={16}/>}<span><strong>{entry.name}</strong>{query.trim()&&<small>{entry.path}</small>}</span>{entry.directory&&<ChevronRight size={13}/>}</button></div>)}
      {!shown.length&&!error&&!loading&&<p className="file-tree-empty">{query.trim()?t('没有匹配的文件或目录'):t('此目录为空')}</p>}
    </div>
    {entries.length>limit&&<button className="file-browser-more" onClick={()=>setLimit(value=>value+150)}>{t('显示更多文件（{count}）',{count:entries.length-limit})}</button>}
    <footer>{t('{count} 个项目',{count:entries.length})}{query.trim()&&t(' · 搜索范围：{path}',{path:at})}</footer>
  </section>;
}
