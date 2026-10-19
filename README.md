# Codex Workbench 2.1

面向个人的 Linux Codex 网页工作台。浏览器通过固定 HTTPS 域名访问，项目、命令和模型任务都在服务器运行。适合 4 核、4GB 内存起步部署。

前端使用 React、TypeScript、CodeMirror 和 xterm.js；后端使用 Node.js 24、SQLite 和官方 Codex app-server。发布包已经包含构建后的前端及运行时依赖，服务器无需构建前端。

## 部署

支持 Ubuntu / Debian，x86_64 或 arm64，以及 systemd。域名 A/AAAA 记录应指向服务器，腾讯云安全组与主机防火墙应允许 80、443 入站；不要开放 47832 或引擎 socket。

```bash
sha256sum -c codex-workbench-2.1.2.tar.gz.sha256
tar -xzf codex-workbench-2.1.2.tar.gz
cd codex-workbench
sudo bash deploy/install.sh --domain codex.example.com
```

替换为你的域名。可通过 `--workspace /srv/your-projects` 指定工作目录；部署参数使用由字母、数字、斜线、点、下划线和连字符组成的绝对路径。已有目录不会被递归更改所有者，必须让服务用户 `codexweb` 可读写。

安装程序会安装独立 Node 24.19.0 与 Codex CLI 0.159.3，使用专用目录，不覆盖你为部署助手安装的 Codex CLI。Node 下载经过 SHA-256 检查；发布文件按清单逐项校验。

Linux 沙箱会安装发行版 `bubblewrap`。Ubuntu 24.04 启用 AppArmor 时，安装器会在官方附加配置存在且配置目录尚未包含该配置时安装并加载 bwrap 配置，不全局关闭限制。[官方沙箱前置条件](https://learn.chatgpt.com/docs/sandboxing#prerequisites)

设置持久化网页口令：

```bash
sudo -u codexweb env DATA_DIR=/var/lib/codex-workbench/web \
  /opt/codex-workbench/runtime/bin/node \
  /opt/codex-workbench/current/scripts/password.mjs
```

口令至少 16 个字符，输入不回显。更改口令会使已有登录失效。浏览器会话有效期为 7 天，服务重启不需要重设口令。

用服务用户登录 ChatGPT：

```bash
sudo -u codexweb env \
  CODEX_HOME=/var/lib/codex-workbench/codex \
  PATH=/opt/codex-workbench/runtime/bin:/usr/bin:/bin \
  /opt/codex-workbench/engines/0.159.3/node_modules/.bin/codex login --device-auth
```

按终端提示在浏览器完成设备码登录。之后打开 `https://你的域名`，输入工作台口令，在左侧添加项目目录。[Codex 官方登录说明](https://learn.chatgpt.com/docs/auth)

## 工作方式

### 项目、会话与模型

- 项目必须位于部署的工作根目录内。添加项目可点击根目录快捷入口、逐级浏览/返回、筛选子目录，或直接输入完整路径。选择的是服务器目录。
- 项目右侧垃圾桶按钮从工作台移除项目，服务器文件和原生会话保留；任务运行、排队或终端未结束时禁止移除。重新注册相同路径后可继续原生会话。
- 会话列表和历史直接读取 Codex 原生接口。支持搜索、分页、重命名、置顶、归档、恢复、分叉和上下文压缩；置顶及项目绑定存放在网页元数据中。
- 置顶会话会在原生历史中逐批查找，保留项目、搜索和归档筛选；较早的置顶会话尚在查找时会显示进度提示。
- 模型、思考强度、计划/执行模式、权限和新会话沙箱可在消息输入框下方直接选择；选项来自实际引擎。切换模型会重置思考强度，避免沿用不支持的值。
- 任务选项用于下一次任务；新会话沙箱仅用于创建会话。运行中追加指令不会重启任务或切换当前模型。主题、账号和工作台更新仍在设置中。
- 默认仅一个模型任务同时运行，其余排队。待处理队列最多 100 项，含待确认/中断记录；历史会话没有该限制。运行中可以追加指令或停止任务；关掉浏览器不会取消任务。
- 未确认结果的请求不自动重发。后端每 5 秒核对运行和待确认任务的原生状态，修复漏掉完成通知或启动回包造成的队列阻塞；已完成回复不会被较旧的快照恢复为运行中。
- 任务队列提供刷新状态、查看原对话和解除等待。无法关联任务 ID 的旧记录可选择“停止此会话当前任务”，需明确确认，因为这可能停止其他客户端在该会话启动的当前任务。随后可解除等待并继续对话。
- 重新打开运行中的会话或断线恢复时，可能短暂显示同步提示；任务继续执行，历史同步后恢复实时更新。

### 文件、终端与 Git

- 文件支持树状浏览、名称/内容搜索、编辑、图片预览、上传、下载和引用到消息。图片可从剪贴板粘贴，附件可拖入输入框。
- 编辑文件上限 2MB；每次上传最多 8 个文件、单个 20MB、合计 80MB。超出上限应在终端或其他文件传输工具处理。
- 上传内容保存到项目的 `.codex-web-uploads/`；该目录不会自动加入 Git。引用过的附件不会自动删除，避免破坏会话上下文。
- 保存文件需匹配读取时的内容摘要；文件被终端或其他程序修改后，会显示冲突并保留编辑内容。
- 最多同时运行两个交互终端。隐藏终端不结束进程，方形按钮结束选中的终端。
- 终端进程依赖当前网关到引擎的连接。网页标签页断线会恢复输出快照；网关重启或引擎连接丢失后，原终端可能结束，需要重新创建。原生模型任务会另外核对状态，不自动重发。
- Git 提供状态、文本差异、选中文件暂存/取消暂存、提交、推送、分支切换、新分支和新工作树。远端 SSH 凭据与提交身份需在服务用户环境配置。代码审查入口在任务队列窗口。
- Git 管理要求项目目录就是仓库或工作树根目录。仓库内部子目录仍可用于聊天和文件操作；如需 Git 管理，请另将仓库根目录注册为项目。

### 审批、技能和插件

- 显示命令、文件修改、网络与额外权限请求，提供引擎允许的决策，不自动批准模型操作。
- 支持文字问题、常用 JSON Schema 表单及 MCP HTTPS 授权链接。浏览器断线期间，审批仍由后端保留，恢复后可继续处理。
- 技能支持选择、启停；插件支持读取当前安装状态、浏览目录、安装和卸载；MCP 支持状态查看、重新加载和 OAuth 授权。具体可用性受账号、权限和原生接口限制。
- 插件安装后若原生接口返回待连接应用，页面会提供相应 HTTPS 授权入口；网页不代替你完成外部服务登录。
- 桌面画面、内嵌浏览器、Computer Use 和桌面专属云功能不在本网页中模拟。若服务器配置了可用工具，Codex 仍可通过原生工具链调用。

## 历史迁移

历史与项目由你自行迁移。本程序不会复制或覆盖现有 Windows 数据，也不会自动合并两个 Codex 数据库。

服务器运行时使用 `/var/lib/codex-workbench/codex` 作为 `CODEX_HOME`。请在引擎停止时完成你自己的迁移，并保持数据归 `codexweb` 用户所有。Windows 原路径可能不存在；网页中打开该会话，点击“绑定到当前服务器项目”，然后继续对话。旧消息中的绝对路径不会被重写。

## GitHub 与网页更新

源码与发布地址：[liulianggui520-ops/codex-web](https://github.com/liulianggui520-ops/codex-web)。首次安装从 Releases 下载对应的 tar.gz 和 sha256 文件；请勿将 GitHub 的 Source code 压缩包当作安装包，它不含预构建前端和运行时依赖。

设置 → 工作台更新 → 检查更新 → 下载并安装。每次更新需要点击确认；不会定时安装。请先保存文件并完成/取消任务、结束终端。更新服务只重启网页，引擎独立保留。短暂断线时不要重复点击，等待状态恢复后刷新页面。校验或兼容性失败不切换，启动健康检查失败自动回滚，更新服务中断后按事务日志恢复。

更新仅支持相同引擎、数据库版本和更新协议的稳定 2.x 发布；引擎、数据库或特权更新服务变更需管理员手动升级。更新服务的代码由安装脚本固定在 root 拥有的目录中，网页发布不能替换它。仅更新受信任的本仓库发布：SHA256 用于检测文件损坏，不替代对仓库维护者的信任。

发布过程：修改代码并递增 package.json 版本后推送 main，GitHub Actions 完成构建、核心与浏览器测试、打包，再创建同版本 Release。已存在的版本不会覆盖，修复需递增版本。也可在 Actions 手动运行 Build and publish，勾选 publish。尚未发布稳定 Release 时，检查更新会明确显示 GitHub 404。

服务器无须 GitHub 令牌。更新包上限 64MB、单文件 32MB、解压总量 256MB、条目 20000；本地最多保留 10 个发布目录，达到上限需管理员保留 current/previous 后清理旧版。更新不会自动修改项目和原生会话。

## 服务、升级与回滚

```bash
sudo systemctl status codex-web codex-engine codex-updater caddy
sudo bash /opt/codex-workbench/current/deploy/diagnose.sh
sudo journalctl --namespace=codex-workbench -u codex-web -u codex-engine -n 100
```

网页与引擎为独立服务；只重启 `codex-web` 不直接杀死引擎。网关恢复后会核对原任务状态，不能确认的任务会等待人工检查，不重新执行。

将新版发布包解压到另一个目录，在该目录执行：

```bash
sudo bash deploy/upgrade.sh
```

升级会保留旧代码、备份网页数据库并切换发布目录；网页在线更新不改变引擎；管理员运行新版安装脚本时，会按清单将不同版本引擎安装在独立目录并重启引擎，请先结束所有任务。回滚网页代码：

```bash
sudo bash /opt/codex-workbench/current/deploy/rollback.sh
```

回滚不自动恢复数据库或覆盖原生会话。此版本网页数据库版本为 1。

## 从 2.1.0 升级时处理旧队列

先打开任务队列，取消尚未启动的任务。对已无原生运行任务的待确认记录，查看历史后点击“已检查历史，解除等待”。如果旧版卡住导致网页拒绝安装更新，可让服务器上的 Codex CLI 下载新版 Release 的 tar.gz 与 sha256，校验并解压，在新版目录执行 sudo bash deploy/upgrade.sh。升级会备份网页数据并保留原生会话；请先结束正在运行的任务和终端。

## 4GB 资源预算

`codex-workbench.slice` 包含网页、引擎及它们的子进程：内存软限 2560MB、硬限 3072MB、CPU 上限为 3 个核心，保留资源给系统与 Caddy。网页 Node 堆上限 384MB。任务默认单并发，终端上限 2 个，空闲会话连接会释放，历史按页读取，输出与重连缓存有界。

这些限制不会保证任意大型项目都能在 4GB 内构建。若项目的编译命令超出组内存上限，进程可能被系统终止；网页将显示中断状态。可以在任务队列和服务日志核查。

## 验证

发布前的实际结果见 `VERIFICATION.md`。服务器部署完成后，应再执行以下真实模型验收：

```bash
sudo -u codexweb env \
  CODEX_HOME=/var/lib/codex-workbench/codex \
  CODEX_SOCKET=/run/codex-workbench/engine.sock \
  SMOKE_ROOT=/srv/codex-workspaces \
  PATH=/opt/codex-workbench/runtime/bin:/usr/bin:/bin \
  /opt/codex-workbench/runtime/bin/node \
  /opt/codex-workbench/current/scripts/real-smoke.mjs
```

自定义工作根目录时同步修改 `SMOKE_ROOT`。该脚本消耗一次真实模型任务，在独立临时项目中验证读文件、修改、执行测试、原生记录及差异；打印 JSON 结果并保留测试目录。不会提交或推送业务代码。

## 开发

源代码与锁文件随包提供。开发依赖使用 pnpm 11.25.0：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:browser
```

浏览器测试使用独立模拟引擎；真实模型验收需另外执行。后端测试临时目录可通过 `TEST_TMPDIR` 指定。修改原生协议时，需用相同版本 CLI 的 `generate-json-schema --experimental` 核对，并同步 `protocol/methods.json`。
