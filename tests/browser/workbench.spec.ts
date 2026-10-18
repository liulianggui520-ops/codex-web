import { test,expect } from '@playwright/test';
import { resolve } from 'node:path';
test.beforeEach(async({page})=>{await page.goto('/');await page.getByRole('textbox',{name:'访问口令'}).fill('test-password-12345678');await page.getByRole('button',{name:'进入工作台'}).click();await expect(page.getByRole('button',{name:'新建会话'})).toBeVisible();});
test('desktop workbench reads native history and displays markdown/code',async({page})=>{
  await page.getByRole('button',{name:'已有原生会话',exact:true}).click();await expect(page.getByText('这是已经保存的原生历史。')).toBeVisible();await expect(page.locator('table')).toBeVisible();await expect(page.locator('.code-block')).toBeVisible();
  await page.screenshot({path:resolve('../..','work','workbench-desktop.png'),fullPage:true});
});
test('new message runs once and survives page reload in native history',async({page})=>{
  await page.getByRole('button',{name:'新建会话'}).click();await page.getByRole('textbox',{name:'给 Codex 的任务'}).fill('从浏览器运行任务');await page.getByRole('button',{name:'发送任务',exact:true}).click();await expect(page.getByText('连接成功。',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('textbox',{name:'访问口令'})).not.toBeVisible();await page.getByRole('button',{name:'从浏览器运行任务',exact:true}).click();await expect(page.getByText('连接成功。',{exact:true})).toBeVisible();
});
test('file editor saves through conflict-aware endpoint and adds context reference',async({page})=>{
  await page.getByRole('button',{name:'README.md',exact:true}).click();await expect(page.locator('.cm-content')).toBeVisible();await page.locator('.cm-content').fill('# Edited in browser\n');await page.getByTitle('保存文件',{exact:true}).click();await expect(page.getByTitle('保存文件',{exact:true})).toBeDisabled();await page.getByTitle('引用到消息').click();await expect(page.locator('.attachment-chips')).toContainText('README.md');
});
test('settings remain available on mobile, with file and terminal tabs',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'设置',exact:true}).last().click();await expect(page.getByRole('dialog',{name:'工作台设置'})).toBeVisible();await page.getByRole('button',{name:'浅色',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.getByRole('button',{name:'关闭窗口'}).click();
  await page.locator('.mobile-tabs').getByRole('button',{name:'文件'}).click();await expect(page.getByRole('button',{name:'README.md',exact:true})).toBeVisible();await page.locator('.mobile-tabs').getByRole('button',{name:'终端'}).click();await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect(page.locator('.terminal-screen')).toContainText('test terminal ready');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve('../..','work','workbench-mobile.png'),fullPage:true});
});
test('cancelled file close and mobile Git navigation retain dirty edits',async({page})=>{
  await page.getByRole('button',{name:'README.md',exact:true}).click();await page.locator('.cm-content').fill('keep this unsaved edit');
  page.once('dialog',dialog=>dialog.dismiss());await page.getByTitle('关闭文件',{exact:true}).click();await expect(page.locator('.cm-content')).toHaveText('keep this unsaved edit');await expect(page.getByTitle('保存文件',{exact:true})).toBeEnabled();
  await page.setViewportSize({width:390,height:844});await page.locator('.mobile-tabs').getByRole('button',{name:'文件',exact:true}).click();page.once('dialog',dialog=>dialog.dismiss());await page.locator('.mobile-tabs').getByRole('button',{name:'Git',exact:true}).click();await expect(page.locator('.cm-content')).toBeVisible();await expect(page.locator('.cm-content')).toHaveText('keep this unsaved edit');
});
test('late file reads cannot replace another file draft',async({page})=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let requested!:()=>void;const started=new Promise<void>(r=>requested=r);
  await page.route('**/api/v2/files/read?**',async route=>{if(new URL(route.request().url()).searchParams.get('path')!=='README.md')return route.continue();const response=await route.fetch();requested();await gate;await route.fulfill({response});});
  await page.getByRole('button',{name:'README.md',exact:true}).click();await started;await page.getByRole('button',{name:'app.js',exact:true}).click();await page.locator('.cm-content').fill('newer app.js draft');release();await expect(page.locator('.file-editor header')).toContainText('app.js');await expect(page.locator('.cm-content')).toHaveText('newer app.js draft');
});
test('typing during a pending save preserves the newer dirty draft',async({page})=>{
  await page.getByRole('button',{name:'app.js',exact:true}).click();await page.locator('.cm-content').fill('first saved version');
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let requested!:()=>void;const started=new Promise<void>(r=>requested=r);let intercepted=false;
  await page.route('**/api/v2/files/save',async route=>{if(intercepted)return route.continue();intercepted=true;const response=await route.fetch();requested();await gate;await route.fulfill({response});});
  await page.getByTitle('保存文件',{exact:true}).click();await started;await page.locator('.cm-content').fill('newer version typed while saving');release();await expect(page.getByTitle('保存文件',{exact:true})).toBeEnabled();await expect(page.locator('.cm-content')).toHaveText('newer version typed while saving');await page.getByTitle('保存文件',{exact:true}).click();await expect(page.getByTitle('保存文件',{exact:true})).toBeDisabled();
});
test('late message acknowledgement preserves the next composer draft',async({page})=>{
  await page.getByRole('button',{name:'新建会话'}).click();await page.getByRole('textbox',{name:'给 Codex 的任务'}).fill('first submitted message');
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let requested!:()=>void;const started=new Promise<void>(r=>requested=r);
  await page.route('**/api/v2/threads/*/turns',async route=>{const response=await route.fetch();requested();await gate;await route.fulfill({response});});
  await page.getByRole('button',{name:'发送任务',exact:true}).click();await started;await page.getByRole('textbox',{name:'给 Codex 的任务'}).fill('my next draft');release();await expect(page.getByRole('textbox',{name:'给 Codex 的任务'})).toHaveValue('my next draft');await expect(page.getByRole('button',{name:'发送任务',exact:true})).toBeEnabled();
});
test('changing project hides the previous project terminal',async({page})=>{
  await page.locator('.statusbar').getByRole('button',{name:'终端',exact:true}).click();await expect(page.locator('.terminal-screen')).toContainText('test terminal ready');await page.getByRole('button',{name:'z-other-project',exact:true}).click();await expect(page.locator('.terminal-screen')).not.toBeVisible();await expect(page.locator('.breadcrumb')).toContainText('z-other-project');
});
test('terminal snapshot recovery replaces missed output and stopped state',async({page})=>{
  let sendGap:()=>void=()=>{};await page.routeWebSocket('**/ws',socket=>{const server=socket.connectToServer();server.onMessage(data=>socket.send(data));sendGap=()=>socket.send(JSON.stringify({type:'sync',payload:{gap:true,seq:0,events:[]}}));});await page.reload();
  await page.locator('.statusbar').getByRole('button',{name:'终端',exact:true}).click();await expect(page.locator('.terminal-screen')).toContainText('test terminal ready');
  await page.route('**/api/v2/terminals',async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch(),data=await response.json();data.terminals=data.terminals.map((t:any)=>({...t,status:'exited',output:'Recovered terminal output\r\n',version:t.version+10}));await route.fulfill({response,json:data});});
  sendGap();await expect(page.locator('.terminal-screen')).toContainText('Recovered terminal output');await expect(page.locator('.terminal-screen')).toContainText('终端未运行');
});
test('highlighted code copies its plain text',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);await page.getByRole('button',{name:'已有原生会话',exact:true}).click();await page.getByRole('button',{name:'复制代码',exact:true}).click();expect((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n')).toBe('console.log("Hello, Codex");\n');
});
test('history approvals merge with requests and resolutions received during loading',async({page})=>{
  let stream:any;await page.routeWebSocket('**/ws',ws=>{stream=ws;ws.connectToServer();});await page.reload();
  let release!:()=>void,requested!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>requested=r);
  const approval=(id:string,originalId:number,command:string)=>({id,originalId,method:'item/commandExecution/requestApproval',params:{threadId:'chat-1',command,availableDecisions:['accept','decline']}});
  await page.route('**/api/v2/threads/chat-1?*',async route=>{const response=await route.fetch(),data=await response.json();data.pending=[approval('existing',77,'echo existing'),approval('resolved',78,'echo resolved')];requested();await gate;await route.fulfill({response,json:data});});
  await page.getByRole('button',{name:'已有原生会话',exact:true}).click();await started;
  stream.send(JSON.stringify({type:'thread/tokenUsage/updated',threadId:'chat-1',payload:{tokenUsage:{total:{totalTokens:12}}}}));stream.send(JSON.stringify({type:'serverRequest/resolved',threadId:'chat-1',payload:{requestId:78}}));stream.send(JSON.stringify({type:'approval/request',threadId:'chat-1',payload:approval('new',79,'echo new')}));
  await expect(page.locator('.composer-note')).toContainText('12 tokens');release();await expect(page.locator('.approval-card')).toHaveCount(2);await expect(page.locator('.approval-stack')).toContainText('echo existing');await expect(page.locator('.approval-stack')).toContainText('echo new');await expect(page.locator('.approval-stack')).not.toContainText('echo resolved');
});
test('MCP secret fields and an unchecked required boolean can be submitted',async({page})=>{
  await page.route('**/api/v2/threads/chat-1?*',async route=>{const response=await route.fetch(),data=await response.json();data.pending=[{id:'mcp-form',method:'mcpServer/elicitation/request',params:{threadId:'chat-1',mode:'form',serverName:'Example tool',requestedSchema:{type:'object',required:['apiKey','enabled'],properties:{apiKey:{type:'string',title:'API key'},enabled:{type:'boolean',title:'Enable optional feature'}}}}}];await route.fulfill({response,json:data});});
  let submitted:any;await page.route('**/api/v2/approvals/mcp-form',async route=>{submitted=route.request().postDataJSON();await route.fulfill({json:{}});});await page.getByRole('button',{name:'已有原生会话',exact:true}).click();await page.getByLabel('API key *',{exact:true}).fill('user-entered-key');await expect(page.getByLabel('API key *',{exact:true})).toHaveAttribute('type','password');await page.locator('.approval-card').getByRole('button',{name:'确认',exact:true}).click();await expect(page.locator('.approval-card')).toHaveCount(0);expect(submitted.content).toEqual({apiKey:'user-entered-key',enabled:false});
});
test('device code login exposes the native verification URL',async({page})=>{
  await page.route('**/api/v2/account/login',route=>route.fulfill({json:{type:'chatgptDeviceCode',loginId:'fixture-login',verificationUrl:'https://example.com/device',userCode:'ABCD-EFGH'}}));await page.getByRole('button',{name:'设置',exact:true}).last().click();await page.getByRole('button',{name:'ChatGPT 设备码登录',exact:true}).click();await expect(page.locator('.device-code')).toHaveText('ABCD-EFGH');await expect(page.getByRole('link',{name:'打开登录页面'})).toHaveAttribute('href','https://example.com/device');
});
test('plugin installation presents required app authorization links',async({page})=>{
  await page.route('**/api/v2/extensions?*',route=>route.fulfill({json:{skills:{data:[]},plugins:{marketplaces:[{name:'test-market',plugins:[{id:'test-plugin',name:'Example plugin',installed:false}]}]},mcp:{data:[]}}}));await page.route('**/api/v2/extensions/action',route=>route.fulfill({json:{authPolicy:'ON_INSTALL',appsNeedingAuth:[{id:'safe-app',name:'Example app',installUrl:'https://example.com/connect'},{id:'unsafe-app',name:'Invalid app',installUrl:'javascript:alert(1)'}]}}));
  await page.getByRole('button',{name:'技能与插件',exact:true}).click();await page.getByRole('checkbox',{name:'浏览插件目录'}).check();await page.getByRole('button',{name:'安装',exact:true}).click();await expect(page.getByRole('heading',{name:'插件还需要连接应用'})).toBeVisible();await expect(page.getByRole('link',{name:'连接应用',exact:true})).toHaveCount(1);await expect(page.getByRole('link',{name:'连接应用',exact:true})).toHaveAttribute('href','https://example.com/connect');
});
test('settings trap keyboard focus and Escape returns to its trigger',async({page})=>{
  const trigger=page.getByRole('button',{name:'设置',exact:true}).last();await trigger.click();for(let i=0;i<24;i++){await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.querySelector('[role="dialog"]')?.contains(document.activeElement))).toBe(true);}await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();await expect(trigger).toBeFocused();
});
test('tablet and phone preserve readable chat width and touch controls',async({page})=>{
  await page.getByRole('button',{name:'已有原生会话',exact:true}).click();await page.setViewportSize({width:820,height:900});await expect(page.locator('.mobile-tabs')).toBeVisible();expect((await page.locator('.chat-column').boundingBox())!.width).toBeGreaterThan(700);await expect.poll(()=>page.locator('.sidebar').boundingBox().then(box=>Math.round(box!.x+box!.width))).toBeLessThanOrEqual(0);await page.screenshot({path:resolve('../..','work','workbench-tablet.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});expect((await page.locator('.mobile-tabs button').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);expect(await page.getByRole('textbox',{name:'给 Codex 的任务'}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve('../..','work','workbench-mobile-chat.png'),fullPage:true});
});
test('uploaded image is visible in native chat history and file preview',async({page})=>{
  await page.getByRole('button',{name:'已有原生会话',exact:true}).click();await page.locator('input[type="file"]').setInputFiles({name:'pixel.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=','base64')});await expect(page.locator('.attachment-chips')).toContainText('pixel.png');await page.getByRole('textbox',{name:'给 Codex 的任务'}).fill('查看图片附件');await page.getByRole('button',{name:'发送任务',exact:true}).click();const img=page.getByRole('img',{name:'消息中的图片'});await expect(img).toBeVisible();await expect.poll(()=>img.evaluate((el:HTMLImageElement)=>el.naturalWidth)).toBe(1);await img.click();await expect(page.locator('.image-preview img')).toBeVisible();
});
test('opening an active chat preserves complete history and resyncs repeated deltas without duplication',async({page})=>{
  let stream:any;await page.routeWebSocket('**/ws',ws=>{stream=ws;ws.connectToServer();});await page.reload();
  let release!:()=>void,requested!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>requested=r);let reads=0;
  await page.route('**/api/v2/threads/chat-1?*',async route=>{const response=await route.fetch(),data=await response.json();reads++;data.turns=[{id:'active-history-turn',status:'inProgress',items:[{id:'history-command',type:'commandExecution',command:'echo previous tool',status:'completed',aggregatedOutput:'previous output'},{id:'history-answer',type:'agentMessage',text:reads===1?'Prefix before snapshot':'Prefix before snapshot aa'}]},{id:'earlier-history-turn',status:'completed',items:[{id:'earlier-answer',type:'agentMessage',text:'Earlier saved turn'}]}];if(reads===1){requested();await gate;}await route.fulfill({response,json:data});});
  await page.getByRole('button',{name:'已有原生会话',exact:true}).click();await started;
  const delta={type:'item/agentMessage/delta',threadId:'chat-1',payload:{threadId:'chat-1',turnId:'active-history-turn',itemId:'history-answer',delta:'a'}};stream.send(JSON.stringify(delta));stream.send(JSON.stringify(delta));await expect(page.locator('.assistant-message').last()).toContainText('aa');release();
  await expect(page.getByText('Prefix before snapshot aa',{exact:true})).toBeVisible();await expect(page.getByText('echo previous tool',{exact:true})).toBeVisible();await expect(page.locator('.turn').first()).toContainText('Earlier saved turn');await expect(page.locator('.turn').last()).toContainText('Prefix before snapshot aa');await expect(page.locator('.history-sync')).not.toBeVisible();expect(await page.locator('.assistant-message').last().innerText()).not.toContain('aaa');expect(reads).toBeGreaterThanOrEqual(2);
});
test('an event gap during a pending history request forces a fresh authoritative read',async({page})=>{
  let stream:any;await page.routeWebSocket('**/ws',ws=>{stream=ws;ws.connectToServer();});await page.reload();let reads=0,release!:()=>void,requested!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>requested=r);
  await page.route('**/api/v2/threads/chat-1?*',async route=>{const response=await route.fetch(),data=await response.json();reads++;data.turns=[{id:'gap-turn',status:'completed',items:[{id:'gap-answer',type:'agentMessage',text:reads===1?'Stale snapshot before gap':'Recovered authoritative snapshot'}]}];if(reads===1){requested();await gate;}await route.fulfill({response,json:data});});
  await page.getByRole('button',{name:'已有原生会话',exact:true}).click();await started;stream.send(JSON.stringify({type:'sync',payload:{gap:true,seq:0,events:[]}}));release();await expect(page.getByText('Recovered authoritative snapshot',{exact:true})).toBeVisible();expect(reads).toBeGreaterThanOrEqual(2);
});

test('update controls work on desktop and mobile and display reboot progress',async({page})=>{
 let state:any={enabled:true,busy:false,current:{version:'2.1.0'},message:'尚未检查更新'};let applied=0;
 await page.route('**/api/v2/updates',route=>route.fulfill({json:state}));
 await page.route('**/api/v2/updates/check',route=>{state={...state,latest:{version:'2.2.0',available:true,url:'https://github.com/liulianggui520-ops/codex-web/releases/tag/v2.2.0'},message:'发现新版本'};return route.fulfill({json:state});});
 await page.route('**/api/v2/updates/apply',route=>{applied++;state={...state,busy:true,message:'正在下载并校验发布包'};return route.fulfill({json:state});});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'设置',exact:true}).last().click();await page.getByRole('button',{name:'检查更新',exact:true}).click();await expect(page.getByRole('button',{name:'下载并安装',exact:true})).toBeEnabled();await page.getByRole('button',{name:'下载并安装',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve('../..','work','updates-mobile.png')});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:resolve('../..','work','updates-desktop.png')});page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'下载并安装',exact:true}).click();await expect(page.getByRole('button',{name:'下载并安装',exact:true})).toBeDisabled();await expect(page.getByText('正在下载并校验发布包')).toBeVisible();expect(applied).toBe(1);state={...state,busy:false,phase:'complete',message:'更新成功，请刷新页面',latest:{...state.latest,available:false}};await expect(page.getByRole('button',{name:'刷新页面',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
