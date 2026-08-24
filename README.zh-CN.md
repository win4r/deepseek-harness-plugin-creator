# DeepSeek Harness Plugin Creator

[English](README.md) | 简体中文

这是一个可复用的 Codex Skill，用于为
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 Cordis
搭建、设计、实现、排错、验证和发布外部 Plugin 与 Bundle 层。

它支持：

- 面向简单模型 Tool Bundle、失败关闭的脚手架
- Bundle Patch、宿主 Plugin 与 Service
- Agent、Session、Goal 与 Job 集成
- Cron、Heartbeat、持久化队列与重启恢复
- 隔离 Worker、子进程、凭证与 Provider Adapter
- Web 客户端扩展
- 按症状组织的安装与加载排错

DeepSeek Harness 仍是预览软件。这个 Skill 会先发现并固定官方目标契约，
然后才会使用 API 快查或生成代码。

## 0.2 合并说明

0.2 版把本项目原有的 Authority、Sandbox、持久化与发布工作流，与
[win4r/dsh-plugin-skill](https://github.com/win4r/dsh-plugin-skill) 的脚手架、
API 快查和症状索引思路合并起来。脚手架与参考文档已依据官方 Harness
契约和对比审计重新实现，并非复制一份固定的本机快照。

## 两种工作模式

| 模式 | 适用场景 | 不能替代的验证 |
| --- | --- | --- |
| 简单 Tool 快速路径 | 新建一个有明确边界的纯字符串 Tool；不含 Worker、Provider、持久化、UI、凭证或外部变更 | 契约发现、Authority 审查、真实 Loader/Profile 验收 |
| 按能力设计路径 | 修改已有 Plugin，或开发 Service、Cron、Worker、Provider、UI 等高风险扩展 | 风险专项测试、包检查、全新 Profile 启动与关闭 |

`references/api-quick-reference.md` 中的 rc.2 示例均明确标注为
`dsh-v0.1.1-rc.2` 示例，不能当成当前 API 使用。

## 安装

把仓库克隆到 Codex Skills 目录：

```bash
git clone https://github.com/win4r/deepseek-harness-plugin-creator.git \
  ~/.codex/skills/deepseek-harness-plugin-creator
```

## 在 Codex 中使用

显式调用 Skill：

```text
$deepseek-harness-plugin-creator 为 DeepSeek Harness 开发并验证一个具备持久化能力的 Cron Plugin。
```

当请求明确涉及 DeepSeek Harness、`dsh` 或 `@deepseek-ai/dsh-*` Plugin
开发时，Codex 也可以自动选择这个 Skill。它不会用于 Codex Plugin、通用
Node.js 包、仅安装请求或只读审查。

## 搭建简单 Tool

脚手架会从目标已安装 Profile 中读取 Cordis、`dsh-tools`、Schemastery 与
DSH 的精确版本。由于发布版 DSH Manifest 可能省略根仓库的 Node Engine，
脚手架从固定的官方 Checkout 读取该契约。证据缺失时会失败关闭；显式
Runtime 覆盖必须是精确语义版本，显式 Engine 也必须来自固定目标。

```bash
node scripts/scaffold_plugin.mjs --help

node scripts/scaffold_plugin.mjs dsh-example \
  --dir /path/to/parent \
  --profile web \
  --dsh-repo /path/to/pinned/deepseek-harness \
  --tool example_echo
```

目标包目录必须不存在，或是一个空的真实目录；脚手架没有覆盖模式。对于
宿主提供的 Runtime，生成包默认使用相同的精确开发依赖与 Peer；只有具备
明确兼容证据后才能放宽 Peer。Plugin 自有库使用精确依赖。此外还包含 Bundle
Patch、测试、发布钩子、安全与说明文件。快速脚手架目前只有
`dsh-v0.1.1-rc.2` 一套完整审计快照；未知目标会失败关闭，直到重新审计
Schemastery 归属与 Toolchain，期间应改走手工能力路径。依赖此产物前，应
生成并提交 Lockfile：

```bash
cd /path/to/parent/dsh-example
npm install
npm run check
node /path/to/skill/scripts/validate_plugin.mjs . --built
```

当需求超出纯字符串 Tool 边界时，应改用按能力设计路径。

## 依赖政策

对于发布源码、声明文件或目标 Client 契约所导入的、宿主提供的 Cordis/DSH
Runtime：

- 在 `devDependencies` 使用目标精确版本，并提交 Lockfile；
- Peer 范围必须包含该精确版本：可以使用精确 Peer；更宽范围需要兼容证据；
- Plugin 自有 Runtime 库使用精确 `dependencies`；在 rc.2 契约中包括
  Schemastery；
- 禁止在外部发布包中使用 `*`、`file:`、`link:` 或 `workspace:`；
- 外部化宿主拥有的 Runtime，防止 Plugin 加载第二份副本。

## 验证这个 Skill

仓库包含确定性的自检、Node 测试与 CI 工作流。发布修改前运行同一入口：

```bash
npm ci
npm run check
```

## 验证 Plugin

静态验证器不会执行项目代码，而是检查 Plugin 的打包发布面：

```bash
node scripts/validate_plugin.mjs /path/to/plugin --built
```

它检查由文件描述符绑定的目录树、Package 与 Patch 归属、Loader 入口面、
Runtime 依赖配对、Client 声明、敏感信息与本机路径、符号链接、硬链接、
目录树竞争及构建后的 Package 子路径。它依赖 `/usr/bin/python3`；所需
POSIX 辅助程序不可用时会失败关闭。

静态检查可以确认 `Config` 的导出面，却不能在不执行候选代码的情况下证明它
实现了 Standard Schema；这一点仍须通过真实 Loader 验证。

静态验证并不等于 Runtime 证明。Skill 仍要求真实 Cordis Context 测试、
真实 Loader/Package Export、精确打包产物，以及全新 Profile 的启动、
行为、正常关闭与资源释放检查。

## 验收受信任的 Plugin

验收辅助程序默认只进行静态检查，不会导入项目代码、运行 Package Script、
打包、安装或启动候选 Plugin：

```bash
node scripts/accept_plugin.mjs /path/to/plugin
```

审阅并信任源码后，才能显式选择执行式验收。候选包必须在
`packageManager` 中声明精确的 `npm@...` 或 `pnpm@...`，本机对应 CLI 也
必须精确匹配：

```bash
node scripts/accept_plugin.mjs /path/to/plugin \
  --trusted-execute \
  --profile web \
  --dsh-bin /path/to/current/dsh
```

`--trusted-execute` 不是 Sandbox。它以调用者的宿主权限运行候选包所声明的
npm 或 pnpm Check 与打包钩子，记录精确 Archive 与 SHA-256，在完整打包生命周期
结束后重新验证源码树，将 Archive 安装到独立的临时 `DSH_HOME`，再验证实际解包出的包、
并在静态验证前后、组合前、启动前及关闭后复核同一份基于描述符遍历的安装树路径/状态元数据，
本包挂载行 ID 及 Web Profile 的有界就绪状态，最后正常终止并确认端口释放。
自动组合验收只适用于挂载自身包根或已导出子路径的 Bundle；纯 Patch Bundle、
非本包行或 Config 变更、未匹配 Patch 诊断，都必须使用 `--pack-only` 并手工
验证组合结果。对于暂不
支持的 Profile，使用 `--pack-only`，再手工执行对应应用的启动与关闭门禁。对于
不支持的 Package Manager，应停留在静态验证，并手工执行打包、精确产物与全新
Profile 门禁。

自动成功只证明已声明的本包挂载行、顶层 DSH 进程、HTTP 就绪端点、正常退出和所报告端口的释放；
它不证明后台后代进程已静默，也不证明文件、Store、Socket 等能力专项资源已
清理。具备这些能力的 Plugin 必须追加对应的资源门禁。

安装树防护包含 `dist`，但摘要针对路径/状态元数据而非文件内容字节，并跳过嵌套的
`.git` 与 `node_modules`。它会拒绝在门禁时仍存在的持久变更，但无法排除同一 UID
进程在两次检查之间完成“修改后恢复”的瞬时竞态。

自动执行与 `--pack-only` 输出的手工 Profile 命令都使用允许列表中的最小运行
环境，不会把环境中的 Provider/API 凭证变量复制给 Package Script 或临时
Profile。这能降低意外泄露，但不构成隔离：已审阅代码仍拥有调用者级别的文件
系统与网络权限。

辅助程序本身没有内置真实 Provider 功能测试，但无法强制候选代码离线运行。
受信任的 Package Script 或启动代码仍拥有宿主文件系统与网络权限，可能自行
调用 Provider，或从磁盘读取凭证。应审阅这些代码，并把预期的模型调用作为
单独披露、显式选择加入的门禁。

## 仓库结构

```text
SKILL.md                       Skill 入口与渐进式路由
agents/openai.yaml             Codex UI 元数据
assets/scaffold/               简单 Tool 包模板
references/contract-discovery.md
references/api-quick-reference.md
references/tool-authority.md
references/sandboxed-workers.md
references/durable-runtime.md
references/client-extensions.md
references/troubleshooting.md
references/release-gates.md
scripts/scaffold_plugin.mjs    失败关闭的简单 Tool 脚手架
scripts/validate_plugin.mjs    Plugin 发布面的静态验证器
scripts/accept_plugin.mjs      默认静态、面向受信任代码的验收辅助程序
scripts/enumerate_tree.py      文件描述符绑定的文件系统辅助程序
scripts/check_skill.mjs        Skill 结构、链接与路径自检
tests/                         确定性回归测试
.github/workflows/ci.yml       仓库 CI 入口
```

## 限制

- API 快查是带版本标签的示例，不能代替官方契约发现。
- 脚手架有意不生成 Cron、Worker、Provider、Service、凭证或 Web UI。
- 快速脚手架会拒绝尚无完整审计快照的 DSH 版本；此时使用手工能力路径。
- rc.2 的 Client 构建 Preset 是源码仓库内部实现；外部 Web 扩展必须复现并
  验证目标版本的 lazy-CJS Bundle 契约。
- 验证器是静态且依赖 POSIX 的，不能证明 Standard Schema 行为、Authority、
  Sandbox 执行、启动或清理。
- 执行式验收会以宿主权限运行受信任的候选代码；临时 `DSH_HOME` 只隔离实时
  Profile，临时 `DSH_AGENTS_HOME` 只隔离 Skill Root；二者都不是代码
  Sandbox，也不会盘点或终止任意后代进程。
- 发布、创建仓库、修改 Profile、调用 Provider 等外部变更仍需用户授权。
