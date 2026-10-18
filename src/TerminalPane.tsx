import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api,subscribe } from './api';
import type { TerminalInfo } from './types';
import '@xterm/xterm/css/xterm.css';
export function TerminalPane({terminal,onError}:{terminal:TerminalInfo;onError:(s:string)=>void}){
  const host=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!host.current)return;
    const term=new Terminal({cursorBlink:true,fontSize:12,fontFamily:'Consolas, "SFMono-Regular", monospace',scrollback:2000,theme:{background:'#131516',foreground:'#d2d6d8',cursor:'#a5e7c4'}}),fit=new FitAddon();term.loadAddon(fit);term.open(host.current);fit.fit();
    let chain=Promise.resolve(),stopped=true,syncing=false,version=-1,disposed=false,syncToken=0,exitedDuringSync=false;const pending:any[]=[];
    const input=term.onData(data=>{if(stopped||syncing)return;chain=chain.then(async()=>{if(!stopped&&!syncing)await api(`/terminals/${terminal.id}`,{action:'input',data});}).catch(error=>{stopped=true;onError(error.message);});});
    const resize=new ResizeObserver(()=>{fit.fit();api(`/terminals/${terminal.id}`,{action:'resize',cols:term.cols,rows:term.rows}).catch(()=>{});});resize.observe(host.current);
    function output(payload:any){if(payload.version>version){term.write(payload.delta);version=payload.version;}}
    function synchronize(){const token=++syncToken;syncing=true;stopped=true;pending.length=0;exitedDuringSync=false;
      api('/terminals').then(data=>{if(disposed||token!==syncToken)return;const snapshot=data.terminals.find((t:TerminalInfo)=>t.id===terminal.id);term.reset();version=snapshot?.version??0;if(snapshot)term.write(snapshot.output);stopped=!snapshot||snapshot.status!=='running'||exitedDuringSync;syncing=false;pending.forEach(output);pending.length=0;if(stopped)term.write('\r\n[终端未运行]\r\n');}).catch(error=>{if(!disposed&&token===syncToken){syncing=false;stopped=true;pending.length=0;onError(error.message);}});
    }
    const unlisten=subscribe(event=>{
      if(event.type==='resync'||(event.type==='connection'&&event.payload.connected)){synchronize();return;}
      if(event.type==='connection'&&!event.payload.connected){stopped=true;return;}
      if(event.type==='terminal/output'&&event.payload.id===terminal.id){if(syncing){if(pending.length<1000)pending.push(event.payload);else synchronize();}else if(event.payload.version>version+1)synchronize();else output(event.payload);}
      if(event.type==='terminal/exited'&&event.payload.id===terminal.id){stopped=true;exitedDuringSync=true;if(!syncing)term.write(`\r\n[终端结束] ${event.payload.error??event.payload.exitCode??''}\r\n`);}
    });
    synchronize();
    return()=>{disposed=true;unlisten();input.dispose();resize.disconnect();term.dispose();};
  },[terminal.id]);
  return <div ref={host} className="terminal-screen" aria-label="交互终端"/>;
}
