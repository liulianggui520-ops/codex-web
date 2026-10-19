import {useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {api,subscribe} from './api';
type Window={usedPercent:number;windowDurationMins?:number|null;resetsAt?:number|null};
type Snapshot={limitId?:string|null;limitName?:string|null;normalModelSlug?:string|null;primary?:Window|null;secondary?:Window|null};
export function fiveHourQuota(data:any,model:string){
  const map:Record<string,Snapshot>=data?.rateLimitsByLimitId??{},legacy:Snapshot|undefined=data?.rateLimits;
  const entries=Object.entries(map),matched=model?entries.filter(([id,snapshot])=>id===model||snapshot.normalModelSlug===model):[];
  const candidates=[...matched,...(map.codex?[['codex',map.codex] as const]:[]),...(legacy?[[legacy.limitId??'codex',legacy] as const]:[]),...entries];
  for(const [id,snapshot]of candidates)for(const window of [snapshot.primary,snapshot.secondary])if(window?.windowDurationMins===300&&typeof window.usedPercent==='number'&&Number.isFinite(window.usedPercent)&&window.usedPercent>=0)return {remaining:Math.max(0,100-window.usedPercent),resetsAt:window.resetsAt,label:id==='codex'?'':snapshot.limitName||id};
  return null;
}
export function QuotaBar({model}:{model:string}){
  const [data,setData]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[updated,setUpdated]=useState(0),[now,setNow]=useState(Date.now());
  const refreshAction=useRef<()=>void>(()=>{});
  useEffect(()=>{
    let active=true,pending=false,again=false,generation=0,timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){
      if(!active)return;if(pending){again=true;return;}pending=true;setBusy(true);const token=generation;
      try{const value=await api('/account/limits');if(active&&token===generation){setData(value);setError('');setUpdated(Date.now());setNow(Date.now());}}
      catch(error){if(active&&token===generation)setError((error as Error).message);}
      finally{pending=false;if(active){setBusy(false);if(again){again=false;timer=setTimeout(refresh,250);}}}
    }
    refreshAction.current=refresh;refresh();
    const close=subscribe(event=>{if(event.type==='connection'){if(event.payload?.connected)refresh();else{generation++;setError('Codex 连接中断，显示上次读取的数据');}return;}if(event.type==='resync'||['account/updated','account/login/completed','account/rateLimits/updated'].includes(event.type)){if(event.type==='account/updated'||event.type==='account/login/completed'&&event.payload?.success){generation++;setData(null);setUpdated(0);setError('');}refresh();}});
    const poll=setInterval(()=>{if(document.visibilityState==='visible')refresh();},60000),clock=setInterval(()=>setNow(Date.now()),30000);
    const visible=()=>{if(document.visibilityState==='visible')refresh();};document.addEventListener('visibilitychange',visible);
    return()=>{active=false;clearInterval(poll);clearInterval(clock);clearTimeout(timer);close();document.removeEventListener('visibilitychange',visible);refreshAction.current=()=>{};};
  },[]);
  const quota=fiveHourQuota(data,model),percent=quota?Math.round(quota.remaining):0;
  const timestamp=quota?.resetsAt,reset=typeof timestamp==='number'&&Number.isFinite(timestamp)&&timestamp>0&&timestamp*1000<=8640000000000000?new Date(timestamp*1000):null;
  const resetText=reset?reset.getTime()>now?`${reset.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})} 重置`:'已到重置时间，等待额度更新':'未提供重置时间';
  return <div className={`quota-bar ${quota&&percent<=10?'quota-low':''} ${error?'quota-stale':''}`} role="group" aria-label="5小时额度">
    <span className="quota-label">5 小时额度{quota?.label&&<small title={quota.label}> · {quota.label}</small>}</span>
    {quota?<><strong>剩余 {percent}%</strong><div className="quota-meter" role="progressbar" aria-label="5小时剩余额度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{width:`${percent}%`}}/></div><span className="quota-reset" title={reset?.toLocaleString('zh-CN')}>{resetText}</span>{error&&<small className="quota-warning" title={error}>上次数据</small>}</>:<span className="quota-empty">{error?'暂时无法读取':busy?'正在读取…':'当前账号未提供 5 小时额度'}</span>}
    <button type="button" className="icon-button quota-refresh" aria-label="刷新5小时额度" disabled={busy} title={error?`${error}；点击重试`:updated?`上次更新：${new Date(updated).toLocaleTimeString('zh-CN')}；点击刷新`:'刷新额度'} onClick={()=>refreshAction.current()}><RefreshCw size={12} className={busy?'spin':''}/></button>
  </div>;
}
