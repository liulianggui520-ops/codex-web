# 给服务器上 Codex CLI 的部署交接

本发布包用于 Ubuntu/Debian 腾讯云服务器，4核4GB，固定域名 HTTPS，个人单用户。用户自行迁移原有项目和会话。不要修改 Windows 上已有服务。

## 执行顺序

1. 读取 `README.md` 和 `VERIFICATION.md`；检查 `/etc/os-release`、架构、systemd、可用磁盘和内存。确认用户提供的域名及项目根目录。
2. 核对发布包 SHA-256。解压后不要重新构建前端；包内已经包含 `dist/` 和运行时依赖。
3. 确认域名指向本机且公网 80/443 可达。保留现有 SSH 与其他网站配置。安装程序以独立 Caddy 片段追加站点，不应覆盖其他站点。
4. 执行 `sudo bash deploy/install.sh --domain <用户域名>`，按需追加 `--workspace <目录>`。若已有目录权限不满足，让用户决定使用新目录或调整该目录权限，不递归更改无关目录。
5. 帮助用户在交互终端设置工作台口令；不要将口令、auth.json 或设备码登录后的令牌输出到最终聊天或报告。脚本 `scripts/password.mjs` 支持不回显的交互输入。
6. 为服务用户 `codexweb`、`CODEX_HOME=/var/lib/codex-workbench/codex` 完成 ChatGPT 设备码登录，或等待用户自行完成账号资料迁移。你当前用于部署的 CLI 登录与运行服务的登录是两个独立环境。
7. 检查 `codex-engine`、`codex-web`、`codex-updater`、`caddy` 服务和公网 HTTPS。确认未登录访问 `/api/v2/projects` 返回 401。保持引擎 Unix socket 和 47832 端口不对公网暴露。
8. 按 README 执行 `scripts/real-smoke.mjs`。必须检查结果 `ok: true`，并保留 `report.json`；若失败，报告真实错误，不把模拟测试当作真实模型通过。
9. 打开浏览器检查桌面与手机布局、模型列表、文件编辑与冲突、终端、Git、审批、历史会话。用用户已经迁移的一个历史会话验证路径绑定和继续对话。
10. 检查 `systemctl show codex-workbench.slice` 的 3GB 内存硬限。实际项目较大时先运行一个任务，不提升默认并发。

## 不能自动做的事

- 不自动复制、合并或重建用户原有 Codex 数据库，不改写旧会话文本中的 Windows 路径。
- 不重置、清理或强制推送业务 Git 仓库。
- 不为解决沙箱报错全局关闭系统安全机制，先核对官方 Codex 的 Linux 沙箱要求和具体错误。
- 不把“systemd 配置文件存在”当成服务运行成功；不把“本地回环可访问”当成公网 HTTPS 验证成功。

## 交付报告至少包含

实际网址、服务状态、原生引擎版本、真实模型验收结果、历史路径绑定结果、资源限制和未通过项。凭据不要出现在报告中。

出现故障先运行 `sudo bash /opt/codex-workbench/current/deploy/diagnose.sh`。网页代码回滚脚本为 `deploy/rollback.sh`；模型引擎及原生历史与网页代码独立保留。

## GitHub 更新入口

从 https://github.com/liulianggui520-ops/codex-web/releases 获取安装包及 .sha256；不要下载 Source code 当安装包。首次安装必须使用 2.1.0 或更新安装脚本，创建 codex-updater 服务。检查 /run/codex-workbench-updater/control.sock 权限为 root:codexweb 0660，不开放网络端口，不给网页用户 sudo 权限。网页设置内检查并安装更新；所有待运行任务、终端结束后才允许更新。更新只覆盖网页发布目录，更新服务、引擎、登录信息、项目及原生历史保持独立。
