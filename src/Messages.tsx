import { Children,isValidElement,useState,type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, GitFork, ChevronRight, Terminal, FileDiff, Wrench } from 'lucide-react';
import type { Item,Turn,Project } from './types';
import { fileURL } from './api';
function plainText(node:ReactNode):string{return Children.toArray(node).map(child=>typeof child==='string'||typeof child==='number'?String(child):isValidElement<{children?:ReactNode}>(child)?plainText(child.props.children):'').join('');}
function CopyButton({text}:{text:string}){const[copied,setCopied]=useState(false),[error,setError]=useState(false);return <button className="icon-button copy-code" aria-label={error?'复制失败，请手动选择代码':'复制代码'} title={error?'浏览器未允许复制，请手动选择代码':copied?'已复制':'复制代码'} onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);setError(false);setTimeout(()=>setCopied(false),1500);}catch{setError(true);}}}>{copied?<Check size={13}/>:<Copy size={13}/>}</button>;}
function Markdown({text}:{text:string}){return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{a:({children,href})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,pre:({children,...props})=><div className="code-block"><CopyButton text={plainText(children)}/><pre {...props}>{children}</pre></div>}}>{text}</ReactMarkdown>;}
function itemText(item:Item){if(item.text)return item.text;return(item.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');}
function MessageImage({content,project,onFile}:{content:any;project?:Project;onFile:(path:string)=>void}){const[failed,setFailed]=useState(false);let src='',relative='';if(content.type==='localImage'&&project){const path=String(content.path??'').replaceAll('\\','/'),root=project.path.replaceAll('\\','/');if(path.startsWith(root+'/')){relative=path.slice(root.length+1);src=fileURL(project.id,relative);}}else if(/^https:\/\//.test(content.url??'')||/^data:image\/(png|jpeg|webp|gif);base64,/.test(content.url??''))src=content.url;
  if(!src||failed)return <span className="attachment-label">图片附件（原路径不可用）</span>;return <a className="message-image" href={src} target="_blank" rel="noopener noreferrer" onClick={relative?e=>{e.preventDefault();onFile(relative);}:undefined}><img src={src} alt="消息中的图片" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/></a>;}
function NativeItem({item,onFile,project}:{item:Item;onFile:(path:string)=>void;project?:Project}){
  if(item.type==='userMessage')return <div className="user-message"><div className="message-label">你</div><div className="user-text">{itemText(item)}</div>{item.content?.filter(c=>c.type==='localImage'||c.type==='image').map((c,i)=><MessageImage key={i} content={c} project={project} onFile={onFile}/>)}</div>;
  if(item.type==='agentMessage'||item.type==='plan')return <article className="assistant-message"><div className="message-label">{item.type==='plan'?'计划':'CODEX'}</div><Markdown text={itemText(item)}/></article>;
  if(item.type==='reasoning'){const value=(item.summary??[]).map((s:any)=>typeof s==='string'?s:s.text??'').join('\n');return value?<details className="tool-card"><summary><ChevronRight size={13}/>思考摘要</summary><Markdown text={value}/></details>:null;}
  if(item.type==='commandExecution')return <details className="tool-card"><summary><Terminal size={14}/><code>{item.command||'运行命令'}</code><span className={`status ${item.status}`}>{item.status||'执行中'}</span></summary><pre>{item.aggregatedOutput||'等待输出…'}</pre>{item.exitCode!==undefined&&<small>退出码 {item.exitCode}</small>}</details>;
  if(item.type==='fileChange')return <details className="tool-card" open><summary><FileDiff size={14}/>文件修改<span className="status">{item.status}</span></summary>{item.changes?.map((change:any,i:number)=><div key={i}><button className="file-link" onClick={()=>onFile(change.path)}>{change.path}</button><pre className="diff">{change.diff}</pre></div>)}</details>;
  if(item.type==='contextCompaction')return <div className="system-note">上下文已压缩</div>;
  if(item.type==='imageGeneration'){const result=String(item.result??''),url=/^(https:\/\/|data:image\/)/.test(result)?result:/^(iVBOR|\/9j\/|R0lGOD|UklGR)/.test(result)?`data:image/${result.startsWith('/9j/')?'jpeg':result.startsWith('R0lGOD')?'gif':result.startsWith('UklGR')?'webp':'png'};base64,${result}`:'';return <details className="tool-card" open><summary><FileDiff size={14}/>生成图片<span className="status">{item.status}</span></summary>{item.savedPath||url?<MessageImage content={item.savedPath?{type:'localImage',path:item.savedPath}:{type:'image',url}} project={project} onFile={onFile}/>:<p>{item.failure?.message??'暂无可预览的图片'}</p>}</details>;}
  if(item.type==='mcpToolCall'||item.type==='dynamicToolCall'||item.type==='webSearch')return <details className="tool-card"><summary><Wrench size={14}/>{item.tool||item.server||item.type}<span className="status">{item.status}</span></summary><pre>{JSON.stringify(item.result??item.contentItems??item.action??{},null,2)}</pre></details>;
  if(item.type==='enteredReviewMode'||item.type==='exitedReviewMode')return <div className="system-note">{item.type==='enteredReviewMode'?'开始代码审查':'代码审查结束'}</div>;
  return <details className="tool-card"><summary><Wrench size={14}/>{item.type}</summary><pre>{JSON.stringify(item,null,2)}</pre></details>;
}
export function TurnView({turn,onFork,onFile,project}:{turn:Turn;onFork:(id:string)=>void;onFile:(path:string)=>void;project?:Project}){return <div className="turn"><div>{turn.items.map(item=><NativeItem key={item.id} item={item} onFile={onFile} project={project}/>)}</div>{turn.error&&<div className="inline-error">{turn.error.message}</div>}<div className="turn-footer"><span>{turn.status==='inProgress'?'正在处理…':turn.status==='interrupted'?'已中断':turn.status==='failed'?'任务失败':''}</span>{turn.status!=='inProgress'&&<button className="text-button" onClick={()=>onFork(turn.id)}><GitFork size={12}/> 从这里分叉</button>}</div></div>;}
export function mergeTurns(previous:Turn[],incoming:Turn[]){const map=new Map(previous.map(t=>[t.id,t]));for(const t of incoming){const old=map.get(t.id);map.set(t.id,{...old,...t,items:t.items?.length?t.items:old?.items??[]});}return [...map.values()];}
export function mergeHistory(previous:Turn[],incoming:Turn[],completeEvents:{type:string;payload:any}[]=[],priorIds=new Set(previous.map(t=>t.id))){
  const snapshots=incoming.map(turn=>({...turn,items:turn.items.map(item=>({...item,__partial:false}))}));
  const ids=new Set(snapshots.map(t=>t.id)),firstOverlap=previous.findIndex(t=>ids.has(t.id)),prefix=previous.filter((t,index)=>!ids.has(t.id)&&(firstOverlap<0?priorIds.has(t.id):index<firstOverlap)),prefixIds=new Set(prefix.map(t=>t.id)),suffix=previous.filter(t=>!ids.has(t.id)&&!prefixIds.has(t.id));
  let result=[...prefix,...snapshots,...suffix];
  for(const event of completeEvents){const p=event.payload;if(event.type==='item/started'&&result.some(t=>t.id===p.turnId&&t.items.some(i=>i.id===p.item.id)))continue;if(event.type==='turn/started'&&result.some(t=>t.id===p.turn.id))continue;result=applyEvent(result,event.type,p);}
  return result;
}
export function applyEvent(turns:Turn[],type:string,p:any):Turn[]{
  if(type==='turn/started')return mergeTurns(turns,[{...p.turn,items:p.turn.items??[]}]);
  if(type==='turn/completed')return mergeTurns(turns,[p.turn]);
  if(!p.turnId||!['item/started','item/completed','item/agentMessage/delta','item/plan/delta','item/commandExecution/outputDelta'].includes(type))return turns;
  const next=[...turns],index=next.findIndex(t=>t.id===p.turnId);let turn:Turn;if(index<0){turn={id:p.turnId,status:'inProgress',items:[]};next.push(turn);}else{turn={...next[index],items:[...next[index].items]};next[index]=turn;}
  if(type==='item/started'||type==='item/completed'){const index=turn.items.findIndex(i=>i.id===p.item.id);if(index<0)turn.items.push(p.item);else turn.items[index]={...turn.items[index],...p.item};}
  else if(type==='item/agentMessage/delta'||type==='item/plan/delta'){const index=turn.items.findIndex(i=>i.id===p.itemId);if(index<0)turn.items.push({id:p.itemId,type:type.includes('/plan/')?'plan':'agentMessage',text:p.delta,__partial:true});else turn.items[index]={...turn.items[index],text:(turn.items[index].text??'')+p.delta};}
  else if(type==='item/commandExecution/outputDelta'){const index=turn.items.findIndex(i=>i.id===p.itemId);if(index>=0)turn.items[index]={...turn.items[index],aggregatedOutput:((turn.items[index].aggregatedOutput??'')+p.delta).slice(-256000)};}
  return next;
}
