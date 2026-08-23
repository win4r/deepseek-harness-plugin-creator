# DeepSeek Harness Plugin Creator

[English](README.md) | 简体中文

这是一个可复用的 Codex Skill，用于设计、实现、验证和发布 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 Cordis 的外部 Plugin 和 Bundle 层。

它支持以下贴近实际开发的 Plugin 形态：

- Bundle Patch 与宿主服务
- 可由模型调用的工具
- Agent、Session、Goal 与 Job 集成
- Cron、Heartbeat、持久化队列与重启恢复
- 隔离 Worker、子进程与 Provider Adapter
- Web 客户端扩展

这个 Skill 不会固化某个预览版本的 API，而会针对每个项目重新发现并固定当前官方 Harness/Cordis 契约。

## 安装

将仓库直接克隆到 Codex Skill 目录：

```bash
git clone https://github.com/win4r/deepseek-harness-plugin-creator.git \
  ~/.codex/skills/deepseek-harness-plugin-creator
```

## 使用

显式调用：

```text
$deepseek-harness-plugin-creator 为 DeepSeek Harness 开发一个具备持久化能力的 Cron 与 Heartbeat Plugin。
```

当请求明确涉及 DeepSeek Harness、`dsh` 或 `@deepseek-ai/dsh-*` Plugin 开发时，Codex 也可以自动选择这个 Skill。它不会用于 Codex Plugin 脚手架、通用 Node.js 包、仅安装请求或只读审查。

## Skill 的核心约束

- 从官方仓库或已固定版本的本地代码检出中发现当前契约
- 在引入 Worker、存储、UI 或自定义循环前，先选择满足需求的最小 Plugin 形态
- 使用 Cordis 命名空间导出并准确声明服务注入
- 让发布代码导入的 Harness/Cordis Runtime 依赖在 `peerDependencies` 与 `devDependencies` 中使用相同的精确版本
- 明确管理注册项、定时器、进程和持久化资源的生命周期
- 为模型工具与外部变更划定清晰的权限边界
- 通过真实 Loader、Package Export、Patch、全新 Profile、关闭流程与发布门禁进行验证
- 单独披露真实模型服务商测试，并要求显式选择加入

按需指导位于 `references/`，每个任务只会加载与当前风险模型相关的内容。

## 验证 Plugin

内置验证器不会执行项目代码，而是检查打包后的 Plugin 发布面：

```bash
node scripts/validate_plugin.mjs /path/to/plugin --built
```

验证器通过 `/usr/bin/python3` 执行基于文件描述符绑定的目录树检查，并验证 Package 与 Patch 归属、命名空间导出、Runtime 依赖配对、发布面中的敏感信息与本机路径、符号链接、硬链接、目录树竞争，以及已挂载的 Package 子路径。如果所需的 POSIX 辅助程序不可用，验证器会以失败状态退出，而不会降低检查标准。

当前版本已在 Node.js 22.20.0 下使用真实的 Pi Review 与 Cron Plugin，以及正向和对抗性测试样例完成测试。

## 仓库结构

```text
SKILL.md                     Skill 入口与路由规则
agents/openai.yaml           Codex UI 元数据
references/                  按风险类型拆分的实现与发布指南
scripts/validate_plugin.mjs  Plugin 发布验证器
scripts/enumerate_tree.py    基于文件描述符绑定的文件系统辅助程序
```

DeepSeek Harness 仍处于预览阶段。每次实现前都应重新核对官方契约与依赖版本。
