import React,{useEffect,useState,useRef} from 'react';
import {Copy,Folder,Plus,Search,Star,Trash2} from 'lucide-react';
import type {TaskTemplate,TemplateState} from '../core/templates';
import type {DeliveryCheck} from '../shared/delivery';
import {Dialog} from './Dialog';
import {DeliveryDialog} from './DeliveryDialog';
import {t,useI18n,errorText} from './i18n';
import {copyText} from './clipboard';
import {filterTemplates,readTemplateLibrary,sameTemplate,templateCloneName,templateLibraryKey,templateProject,toggleTemplateLink,validTemplateLibrary} from './template-library';
import './template-library.css';
export function TaskTemplates({draft,preferences,cwd='',call,apply,close}:{
 draft:string;preferences:Pick<TaskTemplate,'model'|'effort'|'planMode'|'multiAgent'|'deliveryChecks'>;cwd?:string;
 call:(name:string,args?:unknown)=>Promise<any>;apply:(template:TaskTemplate)=>void;close:()=>void;
}) {
 useI18n();
 const [state,setState]=useState<TemplateState>(),[name,setName]=useState(''),[prompt,setPrompt]=useState(draft);
 const [formPreferences,setFormPreferences]=useState(preferences);
 const [editing,setEditing]=useState<TaskTemplate>(),[editRevision,setEditRevision]=useState<number>();
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [checks,setChecks]=useState<DeliveryCheck[]>(()=>structuredClone(preferences.deliveryChecks||[]));
 const [editingChecks,setEditingChecks]=useState(false),[preview,setPreview]=useState<TaskTemplate>(),[removing,setRemoving]=useState<TaskTemplate>();
 const switchPrompt=useRef<HTMLElement>(null);
 const [pendingEditor,setPendingEditor]=useState<{template?:TaskTemplate;clone?:boolean;close?:boolean}>();
 const [query,setQuery]=useState(''),[scope,setScope]=useState<'all'|'favorites'|'project'>('all'),[sort,setSort]=useState<'recent'|'name'>('recent');
 useEffect(()=>{if(pendingEditor){switchPrompt.current?.scrollIntoView({block:'nearest'});switchPrompt.current?.querySelector<HTMLButtonElement>('button')?.focus();}},[pendingEditor]);
 const [libraryBlocked,setLibraryBlocked]=useState(()=>{try{return !validTemplateLibrary(localStorage.getItem(templateLibraryKey));}catch{return true;}});
 const [library,setLibrary]=useState(()=>{try{return readTemplateLibrary(localStorage.getItem(templateLibraryKey));}catch{return {favorites:[],projects:{}};}});
 useEffect(()=>{let alive=true;void call('templates.list').then(value=>{if(alive)setState(value);}).catch(e=>{if(alive)setError(errorText(e));});return()=>{alive=false;};},[]);
 useEffect(()=>{if(libraryBlocked)return;try{localStorage.setItem(templateLibraryKey,JSON.stringify(library));}catch{setNotice(t('模板收藏无法保存；本次仍可使用。'));}},[library,libraryBlocked]);
 const filtered=filterTemplates(state?.items||[],library,query,scope,cwd,sort),linked=new Set(library.projects[templateProject(cwd)]||[]);
 const initialChecks=editing?.deliveryChecks||preferences.deliveryChecks||[];
 const formDirty=editing ? name!==editing.name||prompt!==editing.prompt||JSON.stringify(checks)!==JSON.stringify(initialChecks) : !!name.trim()||prompt!==draft||JSON.stringify(checks)!==JSON.stringify(preferences.deliveryChecks||[]);
 const stale=!!editing&&!!state&&editRevision!==state.revision;
 function reset(){setFormPreferences(preferences);setEditing(undefined);setEditRevision(undefined);setName('');setPrompt(draft);setChecks(structuredClone(preferences.deliveryChecks||[]));}
 function loadEdit(template:TaskTemplate,clone=false){setFormPreferences({model:template.model,effort:template.effort,planMode:template.planMode,multiAgent:template.multiAgent,deliveryChecks:template.deliveryChecks});setPreview(undefined);setEditing(clone?undefined:template);setEditRevision(clone?undefined:state?.revision);setName(clone?templateCloneName(template.name,t('副本')):template.name);setPrompt(template.prompt);setChecks(structuredClone(template.deliveryChecks||[]));setError('');setNotice('');}
 function requestEdit(template?:TaskTemplate,clone=false){if(formDirty){setPendingEditor({template,clone});return;}if(template)loadEdit(template,clone);else reset();}
 async function save(){
   if(!state||busy||stale)return;setBusy(true);setError('');setNotice('');
   const prefs=formPreferences;
   try{setState(await call('templates.save',{revision:editing?editRevision:state.revision,...(editing?{id:editing.id}:{}),template:{name,prompt,model:prefs.model,effort:prefs.effort,planMode:prefs.planMode,multiAgent:prefs.multiAgent,deliveryChecks:checks}}));reset();setNotice(t('模板已保存'));}
   catch(e){setError(errorText(e));try{setState(await call('templates.list'));}catch{}}
   finally{setBusy(false);}
 }
 async function remove(){if(!state||!removing||busy)return;setBusy(true);setError('');try{setState(await call('templates.remove',{id:removing.id,revision:state.revision}));setRemoving(undefined);setNotice(t('模板已删除，当前编辑内容仍保留。'));}catch(e){setError(errorText(e));try{setState(await call('templates.list'));}catch{}}finally{setBusy(false);}}
 async function insert(){
   if(!preview||busy||formDirty)return;setBusy(true);setError('');
   try{const fresh:TemplateState=await call('templates.list');setState(fresh);const current=fresh.items.find(item=>item.id===preview.id);if(!current)throw Error(t('该模板已被删除，请选择其他模板。'));if(!sameTemplate(current,preview)){setPreview(current);setNotice(t('模板已更新，预览已刷新，请再次确认后插入。'));return;}apply(structuredClone(current));close();}
   catch(e){setError(errorText(e));}finally{setBusy(false);}
 }
 return <Dialog title={t('任务模板')} onClose={()=>{if(formDirty)setPendingEditor({close:true});else close();}} busy={busy}><div className="task-templates template-workspace">
   <header><div><h2>{t('任务模板')}</h2><p>{t('先预览，再追加到草稿。不会自动发送任务。')}</p></div><button disabled={busy} onClick={()=>requestEdit()}><Plus size={15}/>{t('从当前草稿新建')}</button></header>
   {error&&<p role="alert" className="template-feedback">{error}</p>}{notice&&<p role="status" className="template-feedback">{notice}</p>}
   {libraryBlocked&&<section className="template-remove-confirm" role="alert"><p>{t('收藏配置无法读取，原始内容仍保留。请先复制，再决定是否重置。')}</p><button type="button" onClick={()=>{try{void copyText(localStorage.getItem(templateLibraryKey)||'').then(()=>setNotice(t('已复制'))).catch(e=>setError(errorText(e)));}catch(e){setError(errorText(e));}}}>{t('复制现有收藏配置')}</button><button type="button" onClick={()=>{setLibrary({favorites:[],projects:{}});setLibraryBlocked(false);}}>{t('明确重置收藏配置')}</button></section>}
   <div className="template-library-toolbar"><label><Search size={15}/><input data-template-search aria-label={t('搜索模板')} placeholder={t('搜索名称、指令或模型')} value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label={t('模板范围')} value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="all">{t('全部模板')}</option><option value="favorites">{t('收藏模板')}</option><option value="project" disabled={!cwd}>{t('此项目的模板')}</option></select><select aria-label={t('模板排序')} value={sort} onChange={e=>setSort(e.target.value as typeof sort)}><option value="recent">{t('最近更新')}</option><option value="name">{t('按名称排序')}</option></select></div>
   <div className="template-library-list">{filtered.map(template=><article key={template.id} data-template-id={template.id}><button className="template-preview-trigger" onClick={()=>{setPreview(template);setNotice('');}}><strong>{template.name}</strong><p>{template.prompt}</p><small>{template.model||t('默认模型')} · {t('交付验收')} {template.deliveryChecks?.length||0}</small></button><div className="queue-actions"><button disabled={libraryBlocked} aria-label={t('收藏模板')} title={t('收藏模板')} aria-pressed={library.favorites.includes(template.id)} onClick={()=>setLibrary(old=>toggleTemplateLink(old,template.id))}><Star size={14}/></button>{cwd&&<button disabled={libraryBlocked} aria-label={t('关联此项目')} title={cwd} aria-pressed={linked.has(template.id)} onClick={()=>setLibrary(old=>toggleTemplateLink(old,template.id,cwd))}><Folder size={14}/></button>}<button disabled={busy} onClick={()=>requestEdit(template)}>{t('编辑')}</button><button disabled={busy} data-template-clone={template.id} onClick={()=>requestEdit(template,true)}><Copy size={13}/>{t('创建副本')}</button><button disabled={busy} onClick={()=>setRemoving(template)} aria-label={t('删除模板：{name}',{name:template.name})}><Trash2 size={13}/></button></div></article>)}</div>
   {state&&!filtered.length&&<p className="template-library-empty">{state.items.length?t('没有匹配的模板，试试其他范围或关键词。'):t('还没有模板，可以把当前草稿保存为第一个模板。')}</p>}
   {preview&&<section className="template-preview" data-template-preview={preview.id}><h3>{t('插入前预览')} · {preview.name}</h3><pre>{preview.prompt}</pre><p>{t('当前草稿会保留，模板指令追加在末尾。模型与运行选项会使用此模板设置。')}</p><small>{preview.model||t('默认模型')} · {preview.effort||t('默认强度')} · {preview.planMode?t('规划模式'):t('执行模式')} · {t('交付验收')} {preview.deliveryChecks?.length||0}</small><p>{t('模板中的验收条件只用于新任务，已有任务的条件保持不变。')}</p>{formDirty&&<p role="status">{t('请先保存或放弃模板编辑，再插入其他模板。')}</p>}<button disabled={busy||formDirty} data-template-insert onClick={()=>void insert()}>{t('确认追加到草稿')}</button><button disabled={busy} onClick={()=>setPreview(undefined)}>{t('关闭预览')}</button></section>}
   {removing&&<section className="template-remove-confirm" role="alert"><p>{t('确认删除模板：{name}？',{name:removing.name})}</p><button disabled={busy} onClick={()=>void remove()}>{t('确认删除')}</button><button disabled={busy} onClick={()=>setRemoving(undefined)}>{t('取消')}</button></section>}
   <form className="template-edit-form" onSubmit={e=>{e.preventDefault();void save();}}><h3>{editing?t('编辑模板'):t('新建模板')}</h3><label>{t('模板名称')}<input data-template-name value={name} maxLength={100} onChange={e=>setName(e.target.value)}/></label><label>{t('任务指令')}<textarea data-template-prompt value={prompt} maxLength={100000} onChange={e=>setPrompt(e.target.value)}/></label><div className="queue-actions"><button type="button" disabled={busy} onClick={()=>setEditingChecks(true)}>{t('交付验收')} · {checks.length}</button><button disabled={busy||!state||!name.trim()||!prompt.trim()||stale} type="submit">{editing?t('保存修改'):t('保存为模板')}</button>{editing&&<button type="button" disabled={busy} onClick={()=>{setEditing(undefined);setEditRevision(undefined);setName(templateCloneName(name,t('副本')));}}>{t('改存为副本')}</button>}<button type="button" onClick={()=>void copyText(prompt).then(()=>setNotice(t('已复制'))).catch(e=>setError(errorText(e)))}>{t('复制指令')}</button></div>
   {stale&&<div className="template-edit-conflict" role="alert"><p>{t('模板列表已变化，你的编辑仍保留。为避免覆盖新版本，请保存为副本，或明确载入最新版本。')}</p><button type="button" disabled={busy} onClick={()=>{const current=state?.items.find(item=>item.id===editing?.id);if(current)loadEdit(current);else{setEditing(undefined);setEditRevision(undefined);}}}>{t('放弃本地编辑并载入最新版本')}</button></div>}</form>
   {pendingEditor&&<section ref={switchPrompt} className="template-remove-confirm" role="alert"><p>{t('当前模板编辑尚未保存，继续会放弃这些编辑。')}</p><button type="button" onClick={()=>void copyText(prompt).then(()=>setNotice(t('已复制'))).catch(e=>setError(errorText(e)))}>{t('复制指令')}</button><button disabled={busy} onClick={()=>{const target=pendingEditor;setPendingEditor(undefined);if(target.close)close();else if(target.template)loadEdit(target.template,target.clone);else reset();}}>{t('放弃编辑并继续')}</button><button disabled={busy} onClick={()=>setPendingEditor(undefined)}>{t('继续编辑')}</button></section>}
   {editingChecks&&<DeliveryDialog purpose="plan" initial={checks} call={call} saveDraft={setChecks} close={()=>setEditingChecks(false)}/>}
 </div></Dialog>;
}
