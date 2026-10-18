import {useEffect,useState} from 'react';
import {Download,RefreshCw,ExternalLink} from 'lucide-react';
import {api} from './api';
import {version} from '../package.json';
export function Updates(){
  const [state,setState]=useState<any>(null),[working,setWorking]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let disposed=false,pending=false;async function load(){if(pending)return;pending=true;try{const data=await api('/updates');if(!disposed){setState(data);if(data.busy||data.phase==='complete')setError('');}}catch(e){if(!disposed)setError((e as Error).message);}finally{pending=false;}}load();const timer=setInterval(load,2500);return()=>{disposed=true;clearInterval(timer);};},[]);
  async function action(kind:string){
    if(kind==='apply'&&!confirm(`安装 ${state.latest.version}？请先保存编辑内容并结束任务和终端。网页会短暂断开，失败时自动回滚。`))return;
    setWorking(true);setError('');try{setState(await api(`/updates/${kind}`,kind==='apply'?{version:state.latest.version}:{}));}catch(e){setError(kind==='apply'?`更新请求未确认，请等待状态刷新，勿重复提交。${(e as Error).message}`:(e as Error).message);}finally{setWorking(false);}
  }
  return <section className="updates-panel"><h3>工作台更新</h3><p>当前版本 <strong>{state?.current?.version??version}</strong>{state?.latest?.available&&<span className="small-tag">新版本 {state.latest.version}</span>}</p><p className="muted" role="status">{state?.message??'正在读取更新服务…'}</p>{error&&<p className="inline-error" role="alert">{error}</p>}<div className="button-row"><button disabled={working||!state?.enabled||state?.busy} onClick={()=>action('check')}><RefreshCw size={14}/>检查更新</button>{state?.latest?.available&&<button className="primary" disabled={working||state?.busy} onClick={()=>action('apply')}><Download size={14}/>下载并安装</button>}{state?.latest?.url&&<a href={state.latest.url} target="_blank" rel="noopener noreferrer">发布说明<ExternalLink size={12}/></a>}{state?.phase==='complete'&&<button onClick={()=>location.reload()}>刷新页面</button>}</div><small className="muted">从公开 GitHub Release 获取正式版。运行任务和终端时暂停更新；引擎或数据格式变更需在服务器运行安装脚本。</small></section>;
}
