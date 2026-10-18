export class ApiError extends Error { constructor(public status:number, message:string, public details?:any) { super(message); } }
let csrf = '';
export const setCSRF = (value:string) => { csrf = value; };
export async function api<T=any>(path:string, input?:unknown):Promise<T> {
  const response = await fetch('/api/v2'+path,{ method:input===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:input===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:input===undefined?undefined:JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) { if (response.status===401 && path!=='/auth/login') window.dispatchEvent(new Event('sessionexpired')); throw new ApiError(response.status,data.error||'请求失败',data.details); }
  return data;
}
export async function upload(projectId:string, files:File[]) {
  const form = new FormData(); files.forEach(file=>form.append('files',file));
  const response = await fetch(`/api/v2/files/upload?projectId=${encodeURIComponent(projectId)}`,{method:'POST',headers:{'X-CSRF-Token':csrf},body:form});
  const data=await response.json(); if(!response.ok)throw new ApiError(response.status,data.error);return data;
}
export const query = (values:Record<string,unknown>) => new URLSearchParams(Object.entries(values).filter(([,v])=>v!==null&&v!==undefined).map(([k,v])=>[k,String(v)])).toString();
export const fileURL = (projectId:string,path:string,download=false) => `/api/v2/files/raw?${query({projectId,path,download})}`;
export type NativeEvent={seq?:number,type:string,threadId?:string,payload:any};
const listeners=new Set<(event:NativeEvent)=>void>();
export const subscribe = (listener:(event:NativeEvent)=>void) => {listeners.add(listener);return()=>{listeners.delete(listener);};};
const dispatch=(event:NativeEvent)=>{for(const listener of listeners)listener(event);};
export function connectStream(status:(connected:boolean)=>void) {
  let closed=false,socket:WebSocket,seq:number|null=null,retry=500,timer:ReturnType<typeof setTimeout>,fallback:ReturnType<typeof setInterval>|undefined,polling=false,generation=0;
  const socketOpen=()=>socket?.readyState===WebSocket.OPEN;
  function receive(event:NativeEvent) {
    if(event.type==='sync') { const snapshot=event.payload; if(snapshot.gap)dispatch({type:'resync',payload:{}});else snapshot.events.forEach(receive);seq=snapshot.seq;return; }
    if(event.seq!==undefined){if(seq!==null&&event.seq<=seq)return;seq=event.seq;}dispatch(event);
  }
  async function poll(){if(polling||closed||socketOpen())return;const token=generation;polling=true;try{const result=await api(`/events?after=${seq??0}`);if(!closed&&token===generation&&!socketOpen())receive({type:'sync',payload:result});}catch{}finally{polling=false;}}
  function open(){if(closed)return;const current=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws${seq===null?'':`?after=${seq}`}`);socket=current;
    current.onopen=()=>{if(socket!==current)return;generation++;retry=500;status(true);clearInterval(fallback);fallback=undefined;};current.onmessage=message=>{if(socket!==current||closed)return;try{receive(JSON.parse(message.data));}catch{}};
    current.onclose=()=>{if(socket!==current)return;status(false);if(closed)return;if(!fallback)fallback=setInterval(poll,2500);timer=setTimeout(open,retry+Math.random()*300);retry=Math.min(retry*2,15000);};
    current.onerror=()=>current.close();
  }
  open();return()=>{closed=true;clearTimeout(timer);clearInterval(fallback);socket?.close();};
}
