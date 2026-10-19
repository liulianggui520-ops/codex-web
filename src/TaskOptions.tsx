type Options={model:string;effort:string;mode:string;permission:string;sandbox:string};
export function TaskOptions({cap,value,onChange}:{cap:any;value:Options;onChange:(next:Options)=>void}){
  const models=cap.models??[],selected=models.find((model:any)=>model.model===value.model)||models.find((model:any)=>model.isDefault)||models[0];
  const update=(patch:Partial<Options>)=>onChange({...value,...patch});
  return <div className="task-options" role="group" aria-label="任务选项">
    <label className="task-option task-option-model"><span>模型</span><select aria-label="模型" value={value.model} onChange={event=>update({model:event.target.value,effort:''})}><option value="">Codex 默认模型</option>{models.map((model:any)=><option key={model.id} value={model.model}>{model.displayName}</option>)}</select></label>
    <label className="task-option"><span>思考强度</span><select aria-label="思考强度" value={value.effort} onChange={event=>update({effort:event.target.value})}><option value="">模型默认</option>{selected?.supportedReasoningEfforts?.map((effort:any)=><option key={effort.reasoningEffort} value={effort.reasoningEffort}>{effort.reasoningEffort}{effort.description?' — '+effort.description:''}</option>)}</select></label>
    <label className="task-option"><span>模式</span><select aria-label="模式" value={value.mode} onChange={event=>update({mode:event.target.value})}><option value="">沿用当前模式</option>{(cap.modes??[]).filter((mode:any)=>mode.mode).map((mode:any)=><option key={mode.mode} value={mode.mode}>{mode.mode==='plan'?'计划模式':mode.mode==='default'?'执行模式':mode.name}</option>)}</select></label>
    <label className="task-option"><span>权限</span><select aria-label="权限" value={value.permission} onChange={event=>update({permission:event.target.value})}><option value="">沿用 Codex 配置</option>{(cap.permissions??[]).map((permission:any)=><option key={permission.id} value={permission.id} disabled={!permission.allowed}>{permission.description||permission.id}{permission.allowed?'':'（不可选）'}</option>)}</select></label>
    <label className="task-option"><span>新会话沙箱</span><select aria-label="新会话沙箱" title={value.permission?'使用所选权限配置；清除权限选择后可设置备用沙箱':'仅用于新会话'} disabled={!!value.permission} value={value.sandbox} onChange={event=>update({sandbox:event.target.value})}><option value="workspace-write">允许写入项目</option><option value="read-only">只读</option></select></label>
  </div>;
}
