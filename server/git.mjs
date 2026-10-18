import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,realpath } from 'node:fs/promises';
import path from 'node:path';
import { check, text, id, fail } from './util.mjs';
const exec = promisify(execFile);
export class Git {
  constructor(files) { this.files = files; }
  async run(projectId, args, timeout = 30000) {
    const cwd = await this.files.resolve(projectId);
    const options={cwd,windowsHide:true,timeout,maxBuffer:2*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}};
    try {
      const root=await exec('git',['rev-parse','--show-toplevel'],options);
      check(await realpath(root.stdout.trim())===cwd,'此项目位于父 Git 仓库内。请将仓库根目录注册为项目后使用 Git 管理。',409);
      const { stdout } = await exec('git', ['-c','core.quotepath=false','-c','core.pager=cat', ...args],options);return stdout;
    } catch (error) { if(error.status)throw error;throw fail(400, (error.stderr || error.message).slice(0, 4000)); }
  }
  async status(projectId) {
    try {
      const [raw, branch, branches] = await Promise.all([this.run(projectId,['status','--porcelain=v1','-z']), this.run(projectId,['branch','--show-current']), this.run(projectId,['for-each-ref','--format=%(refname:short)','refs/heads'])]);
      const parts = raw.split('\0'), files = [];
      for (let i = 0; i < parts.length; i++) { const entry = parts[i]; if (!entry) continue; const status = entry.slice(0,2); files.push({ status, path: entry.slice(3), oldPath: /[RC]/.test(status) ? parts[++i] : null }); }
      return { repository: true, branch: branch.trim(), branches: branches.trim().split('\n').filter(Boolean), files };
    } catch (error) { if (error.status===409||/not a git repository/i.test(error.message)) return { repository: false, files: [], branches: [],reason:error.message }; throw error; }
  }
  async diff(projectId, staged = false, file = null) {
    if (file) await this.files.resolve(projectId, file, true);
    const output = await this.run(projectId, ['diff','--no-ext-diff','--no-textconv', ...(staged ? ['--cached'] : []), ...(file ? ['--',file] : [])]);
    return { diff: output };
  }
  async action(projectId, input) {
    const action = input.action;
    if (action === 'stage' || action === 'unstage') {
      check(Array.isArray(input.paths) && input.paths.length > 0 && input.paths.length <= 200, '请选择文件');
      for (const name of input.paths) await this.files.resolve(projectId, text(name,4096), true);
      if(action==='stage')await this.run(projectId,['add','--',...input.paths]);
      else {let hasHead=true;try{await this.run(projectId,['rev-parse','--verify','HEAD']);}catch(error){if(error.status!==400)throw error;hasHead=false;}await this.run(projectId,hasHead?['restore','--staged','--',...input.paths]:['rm','--cached','-r','-f','--',...input.paths]);}
    } else if (action === 'commit') { check(text(input.message, 2000).trim(), '请输入提交说明'); await this.run(projectId,['commit','-m',input.message], 120000); }
    else if (action === 'push') await this.run(projectId,['push'],120000);
    else if (action === 'switch' || action === 'branch' || action === 'worktree') {
      const branch = text(input.branch,200); await this.run(projectId,['check-ref-format','--branch',branch]);
      if (action === 'switch') await this.run(projectId,['switch','--',branch]);
      if (action === 'branch') await this.run(projectId,['switch','-c',branch]);
      if (action === 'worktree') {
        const base = path.join(this.files.roots[0], '.codex-worktrees'); await mkdir(base, { recursive: true });
        const directory = path.join(base, id());
        await this.run(projectId,['worktree','add','-b',branch,directory]);
        return { project: await this.files.register(directory, branch) };
      }
    } else throw fail(400, '不支持这个 Git 操作');
    return this.status(projectId);
  }
}
