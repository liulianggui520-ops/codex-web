import {useEffect,useState} from 'react';
import {LoaderCircle,Trash2} from 'lucide-react';
import {api} from './api';
import type {Project} from './types';
import './ProjectRemoval.css';

export function ProjectRemoval({project,dirty,busy,onBusy,onSubmit,onCancel}:{project:Project;dirty:boolean;busy:boolean;onBusy:(value:boolean)=>void;onSubmit:(input:any)=>Promise<void>;onCancel:()=>void}){
  const [preview,setPreview]=useState<any>(null),[error,setError]=useState(''),[deleteFiles,setDeleteFiles]=useState(false),[confirmation,setConfirmation]=useState('');
  useEffect(()=>{let cancelled=false;api('/projects/'+encodeURIComponent(project.id)+'/removal-preview').then(value=>{if(!cancelled)setPreview(value);}).catch(error=>{if(!cancelled)setPreview({canDeleteFiles:false,reason:error.message});});return()=>{cancelled=true;};},[project.id]);
  async function submit(event:React.FormEvent){
    event.preventDefault();if(busy)return;setError('');onBusy(true);
    try{await onSubmit(deleteFiles?{deleteFiles:true,confirmationPath:confirmation,etag:preview.etag}:{});}
    catch(error){setError((error as Error).message);}
    finally{onBusy(false);}
  }
  return <form className="project-removal" onSubmit={submit}>
    <p>删除项目 <strong>{project.name}</strong>。默认仅移除工作台登记和会话绑定，服务器文件与 Codex 原生聊天历史会保留。</p>
    <code className="project-removal-path">{project.path}</code>
    {dirty&&<p className="inline-error">当前项目有未保存的编辑，删除后将关闭编辑器，请先保存或复制需要保留的内容。</p>}
    <label className="check-label"><input type="checkbox" checked={deleteFiles} disabled={busy||!preview?.canDeleteFiles} onChange={event=>{setDeleteFiles(event.target.checked);setConfirmation('');setError('');}}/>同时永久删除服务器上的文件夹</label>
    {!preview&&<p className="muted">正在检查文件夹…</p>}
    {preview?.reason&&<p className="muted">{preview.reason}{!preview.recoveryPath?'；仍可仅移除工作台登记。':''}</p>}
    {preview?.recoveryPath&&<p className="inline-error">上次删除尚未完成，剩余文件位于 <code>{preview.recoveryPath}</code>。请勾选删除文件夹后重试，或请管理员恢复目录。</p>}
    {deleteFiles&&<div className="project-removal-warning"><p>文件夹内的所有文件、Git 仓库和未提交修改将永久删除，无法从网页撤销。Codex 原生聊天历史仍保留。</p><label>输入完整项目路径确认删除<input aria-label="确认删除的完整项目路径" value={confirmation} onChange={event=>setConfirmation(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false}/></label></div>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <div className="button-row"><button type="button" disabled={busy} onClick={onCancel}>取消</button><button className={deleteFiles?'danger-button':'primary'} disabled={busy||!!preview?.recoveryPath&&!deleteFiles||deleteFiles&&(!preview?.canDeleteFiles||confirmation!==project.path)}>{busy?<LoaderCircle size={15} className="spin"/>:<Trash2 size={15}/>} {busy?'正在删除…':deleteFiles?'永久删除项目及文件夹':'仅移除工作台项目'}</button></div>
  </form>;
}
