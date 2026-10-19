import { EventEmitter } from 'node:events';
export class FakeRpc extends EventEmitter {
  constructor(root) { super(); this.root=root; this.ready=false;this.calls=[];this.replies=[];this.chats=new Map();this.counter=0;this.turnCounter=0;this.autoComplete=false;this.info={userAgent:'Codex test engine'}; }
  async connect(){this.ready=true;return this;}
  async call(method,params={}) {
    this.calls.push({method,params});
    if(method==='thread/loaded/list')return{data:[...this.chats.keys()],nextCursor:null};
    if(method==='model/list')return{data:[{id:'fixture',model:'fixture-model',displayName:'Fixture model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'默认'}]}]};
    if(method==='collaborationMode/list')return{data:[{name:'Plan',mode:'plan',model:'fixture-model'}]};
    if(method==='permissionProfile/list')return{data:[{id:'read-only',allowed:true,description:'只读'}]};
    if(method==='account/read')return{account:{type:'chatgpt',email:'owner@example.test',accessToken:'never-return-this-token'}};
    if(method==='account/rateLimits/read')return{rateLimits:{limitId:'codex',primary:{usedPercent:15,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+10800},secondary:{usedPercent:40,windowDurationMins:10080}}};
    if(method==='configRequirements/read')return{requirements:null};
    if(method==='thread/start'||method==='thread/fork') {
      const thread={id:`chat-${++this.counter}`,name:null,preview:'新会话',cwd:params.cwd??this.root,status:{type:'idle'},turns:[],historyMode:'paginated',updatedAt:Date.now()/1000};this.chats.set(thread.id,thread);return{thread,model:'fixture-model'};
    }
    if(method==='thread/list'){let data=[...this.chats.values()].filter(t=>!!t.archived===!!params.archived);if(params.searchTerm)data=data.filter(t=>(t.name||t.preview).includes(params.searchTerm));const start=Number(params.cursor)||0,end=start+(params.limit||40);return{data:data.slice(start,end).map(t=>({...t,turns:[]})),nextCursor:end<data.length?String(end):null};}
    const chat=params.threadId&&this.chats.get(params.threadId);
    if(method==='thread/read'){if(!chat)throw Object.assign(new Error('Thread not found'),{status:404});return{thread:{...chat,turns:params.includeTurns?chat.turns:[]}};}
    if(method==='thread/resume')return{thread:chat,model:'fixture-model'};
    if(method==='thread/turns/list'){const all=[...chat.turns].reverse(),start=Number(params.cursor)||0,end=start+(params.limit||12);return{data:all.slice(start,end),nextCursor:end<all.length?String(end):null};}
    if(method==='thread/name/set'){chat.name=params.name;return{};}
    if(method==='thread/archive'||method==='thread/unarchive'){chat.archived=method==='thread/archive';return{};}
    if(method==='turn/start'||method==='review/start'){
      const turn={id:`turn-${++this.turnCounter}`,status:'inProgress',items:[{type:'userMessage',id:`user-${this.turnCounter}`,content:params.input??[{type:'text',text:'代码审查'}]}]};chat.turns.push(turn);chat.status={type:'active'};
      if(params.input?.[0]?.text)chat.preview=params.input[0].text.slice(0,60);
      this.emit('notification',{method:'turn/started',params:{threadId:chat.id,turn}});
      if(this.autoComplete)setTimeout(()=>this.complete(chat.id),150);
      return{turn};
    }
    if(method==='turn/interrupt'){this.complete(chat.id,'interrupted');return{};}
    if(method==='turn/steer')return{turnId:params.expectedTurnId};
    if(method==='skills/list')return{data:[{cwd:this.root,skills:[{name:'fixture-skill',path:this.root+'/SKILL.md',description:'测试技能',enabled:true}]}]};
    if(method==='plugin/installed')return{plugins:[]};if(method==='plugin/list')return{marketplaces:[]};if(method==='mcpServerStatus/list')return{data:[]};
    if(method==='command/exec')return new Promise(resolve=>{this.terminalResolve??=new Map();this.terminalResolve.set(params.processId,resolve);setTimeout(()=>this.emit('notification',{method:'command/exec/outputDelta',params:{processId:params.processId,deltaBase64:Buffer.from('test terminal ready\r\n$ ').toString('base64')}}),20);});
    if(method==='command/exec/terminate'){this.terminalResolve?.get(params.processId)?.({exitCode:0});return{};}
    return{};
  }
  complete(threadId,status='completed'){
    const chat=this.chats.get(threadId),turn=chat.turns.at(-1);if(!turn)return;
    const item={id:`answer-${turn.id}`,type:'agentMessage',text:'连接成功。\n\n```js\nconsole.log("hello");\n```'};turn.items.push(item);
    this.emit('notification',{method:'item/completed',params:{threadId,turnId:turn.id,item}});turn.status=status;chat.status={type:'idle'};
    this.emit('notification',{method:'turn/completed',params:{threadId,turn}});
  }
  reply(id,result){this.replies.push({id,result});}
  reject(id){this.replies.push({id,rejected:true});}
  close(){this.ready=false;for(const resolve of this.terminalResolve?.values()??[])resolve({exitCode:0});}
}
