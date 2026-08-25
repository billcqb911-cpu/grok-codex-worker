# Grok Codex Worker 中文使用手册

本文说明如何在 Codex App 的任意项目中使用 `grok-codex-worker`，让 Codex
作为主控模型，在合适的时候把受限的项目工作交给 Grok 4.6，并对实际文件变化、
测试结果和权限策略进行验证。

本文提供两个统一入口：**Grok Auto (Standard)** 和 **Grok Auto (Personal)**。
普通用户不需要判断应该调用
`grok_personal_read`、`grok_rescue`、`grok_plan` 还是 `grok_review`；直接描述目标即可。直接调用 MCP
的方式保留给需要精确控制文件范围、测试命令或后台任务的高级场景。

## 目录

1. [工作原理](#1-工作原理)
2. [使用前提](#2-使用前提)
3. [安装插件](#3-安装插件)
4. [技能与 MCP 工具的区别](#4-技能与-mcp-工具的区别)
5. [Grok Auto 统一入口](#5-grok-auto-统一入口)
6. [Grok Auto 如何自动决策](#6-grok-auto-如何自动决策)
7. [Grok Auto 的自然语言使用示例](#7-grok-auto-的自然语言使用示例)
8. [自动写入任务的安全契约](#8-自动写入任务的安全契约)
9. [后台任务](#9-后台任务)
10. [高级用法：直接调用 MCP](#10-高级用法直接调用-mcp)
11. [普通代码目录与 Git 仓库](#11-普通代码目录与-git-仓库)
12. [权限与责任边界](#12-权限与责任边界)
13. [数据与日志](#13-数据与日志)
14. [无人值守使用边界](#14-无人值守使用边界)
15. [常见问题](#15-常见问题)
16. [更新开发版本](#16-更新开发版本)
17. [快速参考](#17-快速参考)

## 1. 工作原理

实际调用链路如下：

```text
用户
  -> Codex App 当前 task 中的 GPT 模型（主控、计划、审核）
  -> grok-codex-worker MCP
  -> 本机 Grok Build CLI
  -> CC Switch
  -> Grok 4.6 上游
  -> 受限地读取或修改目标项目
  -> 插件检查权限策略、SHA-256、变更范围和测试
  -> Codex 审核结果并向用户交付
```

Codex 始终是主控。Grok 是受限的项目 worker，不会获得 Codex 的完整权限。

## 2. 使用前提

本机需要：

- Codex App；
- Node.js 18.18 或更高版本；
- Grok Build CLI；
- 可用的 Grok 认证或 CC Switch 路由；
- 已安装并启用 `grok-codex-worker` 插件；
- 使用 PR 审查功能时，项目需要是 Git 仓库，并按需安装 GitHub CLI。

检查 Grok CLI：

```powershell
$grok = Join-Path $env:USERPROFILE '.grok\bin\grok.exe'
& $grok version
& $grok doctor
```

检查 Grok 4.6 路由：

```powershell
& $grok -p "只回复 GROK_46_OK" `
  --model grok-4.6 `
  --no-subagents `
  --disable-web-search `
  --max-turns 1
```

预期只返回：

```text
GROK_46_OK
```

## 3. 安装插件

### 3.1 当前电脑

当前开发目录示例：

```text
E:\APP\CodexProject\grok-codex-worker
```

PowerShell 可能禁止执行 npm 生成的 `codex.ps1`。推荐直接使用 `codex.cmd`：

```powershell
$codexCmd = Join-Path $env:APPDATA 'npm\codex.cmd'

& $codexCmd plugin marketplace add `
  'E:\APP\CodexProject\grok-codex-worker'

& $codexCmd plugin add `
  'grok-codex-worker@grok-codex-worker'
```

`plugin marketplace add` 的参数是包含 `.agents/plugins/marketplace.json` 的仓库
根目录，不是 `.agents/plugins` 子目录。

检查安装状态：

```powershell
& $codexCmd plugin list
```

预期出现：

```text
grok-codex-worker@grok-codex-worker  installed, enabled
```

安装或更新后必须：

1. 完全重启 Codex App；
2. 在目标项目中创建一个新 task；
3. 不要使用更新前已经打开的旧 task 验证新技能或新 MCP。

### 3.2 另一台电脑

先克隆自己的 fork：

```powershell
git clone `
  https://github.com/billcqb911-cpu/grok-codex-worker.git `
  E:\APP\CodexProject\grok-codex-worker
```

如果功能尚未合并到默认分支，可指定对应分支：

```powershell
git clone --branch codex/phase7a `
  https://github.com/billcqb911-cpu/grok-codex-worker.git `
  E:\APP\CodexProject\grok-codex-worker
```

然后执行上一节的 marketplace 和 plugin 安装命令。

## 4. 技能与 MCP 工具的区别

Codex App 输入框中的 `/` 用于打开技能菜单。技能负责告诉 Codex如何决策和使用
工具；MCP 工具才会真正启动 Grok CLI。

本插件中的主要技能：

| 技能 | 用途 |
| --- | --- |
| Grok Auto (Standard) | 保持原有数据披露策略，由 Codex 自动选择执行路径 |
| Grok Auto (Personal) | 个人项目模式：凭据脱敏后允许普通源码和数据外发，支持读写 |
| Grok Brand Media | 图片和视频提示规范 |
| Grok Routing | Codex 内部路由指导 |
| Grok Prompting | Codex 内部任务提示整理 |
| Grok CLI Runtime | Codex 内部 MCP/companion 调用契约 |
| Grok Workflows | Codex 内部 workflow 使用指导 |

普通开发和修复任务使用 **Grok Auto (Standard)**。个人项目如果允许将普通源码和数据发送到配置的远程 Grok 上游，选择 **Grok Auto (Personal)**。

## 5. Grok Auto 统一入口

### 5.1 启用

在目标项目的新 task 中：

1. 在输入框输入 `/`；
2. 选择 `Grok Auto (Standard)`；个人源码外发场景选择 `Grok Auto (Personal)`；
3. 在技能标签后输入 `on`，也可以同时附带项目任务；
4. 发送消息。

例如：

```text
on

检查当前项目存在的问题，修复影响最大的缺陷并运行测试。
```

也可以显式提及技能：

```text
$grok-auto on

检查当前项目存在的问题，修复影响最大的缺陷并运行测试。
```

Codex 应简短确认：

```text
Grok Auto (Standard): AUTO
```

随后，当前 task 中的请求由 Codex 自动判断是否需要 Grok。用户不需要自己选择具体
MCP 工具。

### 5.2 只使用一次

重新从 `/` 菜单选择 Grok Auto，然后输入：

```text
once

分析并修复当前测试失败。
```

Codex 应确认：

```text
Grok Auto (Standard): ONCE
```

自动路由只应用于这一项实质任务，完成后回到 `OFF`。

### 5.3 查看状态

选择 Grok Auto 后输入：

```text
status
```

只返回当前 task 的状态：

```text
Grok Auto (Standard): AUTO
```

或：

```text
Grok Auto (Standard): ONCE
Grok Auto (Standard): OFF
```

查询状态不会调用 Grok。

### 5.4 关闭

选择 Grok Auto 后输入：

```text
off
```

或者：

```text
$grok-auto off
```

个人模式示例：

```text
$grok-auto-personal on
```

个人模式允许普通源码、算法、业务规则、客户数据、内部 URL 和数据库结构通过
CC Switch 发送到配置的远程 Grok 上游，但会先创建临时副本并排除或替换 API key、
私钥、密码、token、JWT、凭据文件和连接串密码。个人模式同时支持只读分析和写入任务；
默认使用 `grok-4.6 + high`；
写入只发生在临时副本，经过二次扫描、范围检查、测试和快照验证后才回写原工作区。
它不会放宽 Grok 的 strict 沙箱、Bash/MCP/Web 禁止规则或宿主能力边界。

Personal 模式的项目授权是任务级的：`on` 只作用于当前 Codex 工作区，不会长期授权
其他项目。当前工作区只需输入 `once` 和需求，不需要重复发送授权句子：

```text
[$grok-codex-worker:grok-auto-personal]
once
需求：只读分析本项目是做什么的。
```

需要读取工作区外的项目时，才在同一条请求中使用 `once` 并明确指定项目根目录：

```text
[$grok-codex-worker:grok-auto-personal]
once
授权项目："E:\\APP\\MoneyPrinterTurbo\\MoneyPrinterTurbo"
需求：只读分析这个项目的合成视频逻辑，不修改任何文件。
```

插件会要求 `authorizedProject` 与 `cwd` 完全匹配。任务完成后授权立即清除，不会被
`on`、后续 task 或上下文压缩继承。`off` 和 `status` 不读取项目，也不会调用 Grok。
这项授权只允许凭据脱敏后的数据外发，不能替代 Codex 对该路径的本地读取权限。

Personal 的只读任务会调用专用的 `grok_personal_read`。该工具在 MCP 层静态声明为
只读、非破坏性，同时如实声明会把脱敏暂存副本发送到配置的远程 Grok 上游，因此不会
再把普通源码调查误送进 `grok_rescue` 的写入审批流程。每次 Personal MCP 调用都必须
把 Codex `environment_context.cwd` 原样传为 `activeWorkspace`。当前工作区的 `cwd` 与
`activeWorkspace` 相同且不得传 `authorizedProject`；外部项目保持原 `activeWorkspace`，
并把外部路径同时传给 `cwd` 和 `authorizedProject`。需要修改源码时仍调用
`grok_rescue`，并保留文件白名单、快照、测试和失败回滚。

为了让大型项目可以稳定调用，临时副本默认不包含 `node_modules`、`.venv`、`dist`、
`build`、`.next`、`coverage` 等依赖、构建和缓存目录，也不包含二进制文件或超过
10 MiB 的单个文件；源码、算法、SQL、数据库结构、普通配置和文档仍会保留。
模型可见的 MCP 参数也不会再提供必然被策略拒绝的 custom agent、memory 启用或
caller allow 规则。

Codex 应确认：

```text
Grok Auto (Standard): OFF
```

关闭后，当前 task 中的新请求由 Codex 模型自行处理，不再自动委派给 Grok。

关闭只阻止启动新的 Grok 任务，不会取消已经运行的后台任务。如需取消，必须明确
提供任务 ID：

```text
关闭 Grok Auto，并取消 Grok 后台任务 task-xxxx。
```

### 5.5 只让当前请求不用 Grok

不需要关闭整个 AUTO 模式，可以说：

```text
本次请求不要调用 Grok，由 Codex 自己完成。后续保持 Grok Auto (Standard): AUTO。
```

本次任务结束后，后续请求仍可以自动路由。

### 5.6 状态范围

Grok Auto 是当前 task 的对话状态，不是全局配置：

| 场景 | 行为 |
| --- | --- |
| 当前 task 启用 AUTO | 只影响当前 task |
| 打开另一个 task | 不继承 |
| 创建新 task | 默认 OFF |
| 重启 Codex App | 新 task 默认 OFF |
| 切换项目 | 不写入新项目 |
| 删除 task | 状态随对话消失 |

它不会修改项目 `AGENTS.md`、`.codex/config.toml`、Grok 配置或全局 Codex
配置。Codex 依靠当前对话上下文记住该状态。

## 6. Grok Auto 如何自动决策

| 用户意图 | 自动处理方式 |
| --- | --- |
| 简单改名、单行修复、明确小改动 | Codex 直接完成 |
| 复杂调试、跨模块实现、第二意见 | `grok_rescue` |
| 实现方向明显不清楚 | `grok_plan` |
| 设计文档或多阶段 PR 计划 | `grok_design`，必要时再 `grok_execute_plan` |
| 独立代码审查 | `grok_review` |
| 对方案进行反向质疑 | `grok_adversarial_review` |
| 图片、视频或文档 | 对应的 Grok 专用工具 |
| GitHub、浏览器、登录、其它 MCP | Codex 自己执行宿主步骤 |

自动路由不是“所有工作都强制使用 Grok”。Codex 应在 Grok 能提供实际价值时才委派，
避免为展示调用而增加成本和时间。

## 7. Grok Auto 的自然语言使用示例

启用 AUTO 后，可以直接输入普通任务，不需要写 MCP 参数。

### 7.1 项目分析

```text
分析当前项目架构，找出最可能造成数据损坏或并发错误的模块，并给出证据。
```

### 7.2 修复缺陷

```text
修复当前项目的登录状态丢失问题。先定位根因，严格控制修改范围，完成后运行相关测试和完整测试。
```

### 7.3 提高测试覆盖率

```text
检查当前测试覆盖缺口，优先补充一个高价值模块的单元测试，不要为覆盖率添加无意义断言。
```

### 7.4 制定计划但不修改代码

```text
只分析当前项目，为数据库迁移功能制定实施计划。不要修改源代码。
```

### 7.5 独立审查

```text
对当前分支进行独立代码审查，重点检查认证绕过、数据丢失、竞态条件和缺失测试。
```

### 7.6 需要 GitHub 操作

```text
审查当前分支。代码分析可以交给 Grok，但创建 PR、读取 GitHub 状态和提交评论必须由 Codex 完成。
```

## 8. 自动写入任务的安全契约

Grok Auto 在写入任务中应自动使用以下保护：

- `snapshot=true`：任务前记录工作区快照；
- `rollbackOnFailure=true`：失败时恢复任务前状态；
- `expectedFiles`：必须真实发生变化的目标文件；
- `allowedChangedFiles`：允许发生变化的严格文件白名单；
- `forbiddenChangedPaths`：禁止修改的文件或目录；
- `checkCommand`：Grok 返回后由 companion 执行的验证命令；
- SHA-256：比较任务前后的真实文件内容；
- `contract.verified=true`：所有必要证据同时通过才视为完成。

如果任务开始时还无法可靠确定具体文件范围，Codex 应先执行只读调查，再发起受限
写入，而不是猜测白名单。

插件不会只根据 Grok 的文字说明判断成功。以下情况都会失败：

- Grok 声称写入，但实际变更为 0；
- `expectedFiles` 只是原来存在，没有发生变化；
- 修改了白名单之外的文件；
- 触碰了禁止路径；
- 测试命令退出码非 0；
- 权限策略证据缺失或不合格；
- 快照无法验证大型文件或符号链接的变化；
- 回滚后仍残留改动。

## 9. 后台任务

耗时任务可使用后台模式。Grok Auto 会在适合时选择 `background=true`，并获得
`jobId`。

后台任务不会因为当前 Codex 回复结束而自动取消。Codex 应使用：

- `grok_status`：读取进度；
- `grok_result`：读取最终结果和验证证据；
- `grok_cancel`：显式取消。

当多个任务同时运行时，每次查询都必须携带对应 `jobId`，不能依赖“最近一个任务”。

同一个目标工作区可以并发运行只读、状态、结果和取消调用，但同一时间只允许一个写入任务。
第二个写入任务会在 Grok 启动和快照创建前失败，避免两个任务的快照、校验或回滚互相覆盖。

取消不是“发出 kill 就算完成”。插件会先记录 `cancel_requested`，终止该任务拥有的进程树，
等待进程确认关闭，再执行变更检查和必要回滚，最后只发布一个终态结果。

## 10. 高级用法：直接调用 MCP

一般用户可以跳过本节。需要精确控制时，明确要求“只调用 MCP 工具”。

### 10.1 检查环境

```text
请只调用 MCP 工具 grok_setup：

cwd="E:\APP\MyProject"

只返回 CLI、版本、认证和 doctor 结果，不修改任何文件。
```

### 10.2 只读分析

Personal 脱敏源码分析：

```text
请只调用 MCP 工具 grok_personal_read：

cwd="E:\APP\MyProject"
activeWorkspace="E:\APP\MyProject"
prompt="只读分析当前项目结构和主要风险。禁止创建、修改或删除任何文件。"
model="grok-4.6"
effort="high"
```

`grok_personal_read` 会在服务端强制只读、Personal 脱敏、fresh、no-memory、无子代理和
无网页搜索；这些安全字段不需要也不能由调用者重复传入。`activeWorkspace` 必须来自
当前 Codex task 的 `environment_context.cwd`，不能使用插件安装缓存目录，也不能为了
绕过外部项目检查而改成目标 `cwd`。Standard 模式的普通只读
委托仍可使用 `grok_rescue + readOnly=true`。

### 10.3 严格限制单文件写入

```text
请只调用 MCP 工具 grok_rescue：

cwd="E:\APP\MyProject"
prompt="只修改 tests/unit/test_example.py，新增一个有实际价值的测试。不得修改 src。"
model="grok-4.6"
expectedFiles=["tests/unit/test_example.py"]
allowedChangedFiles=["tests/unit/test_example.py"]
forbiddenChangedPaths=["src"]
snapshot=true
rollbackOnFailure=true
checkCommand=".venv\Scripts\python.exe -m pytest"
checkTimeoutMs=120000
fresh=true
noSubagents=true
disableWebSearch=true
```

### 10.4 后台任务

```text
请只调用 MCP 工具 grok_rescue：

cwd="E:\APP\MyProject"
prompt="分析并修复当前失败测试，严格控制修改范围并运行完整测试。"
model="grok-4.6"
background=true
snapshot=true
rollbackOnFailure=true
fresh=true
noSubagents=true
disableWebSearch=true
```

查询任务：

```text
请调用 MCP 工具 grok_status：
cwd="E:\APP\MyProject"
jobId="task-xxxx"
```

读取最终结果：

```text
请调用 MCP 工具 grok_result：
cwd="E:\APP\MyProject"
jobId="task-xxxx"
```

取消任务：

```text
请调用 MCP 工具 grok_cancel：
cwd="E:\APP\MyProject"
jobId="task-xxxx"
```

### 10.5 计划和审查

计划任务：

```text
请调用 MCP 工具 grok_plan：
cwd="E:\APP\MyProject"
prompt="分析当前架构并制定缓存层重构计划。"
model="grok-4.6"
```

`grok_plan` 会创建或更新 `.grok-plans/` 下的计划文件，不属于完全不写文件的
只读操作。要求项目完全零写入时，应使用 `grok_rescue` 并设置 `readOnly=true`。

Git 分支审查：

```text
请调用 MCP 工具 grok_review：
cwd="E:\APP\MyProject"
base="main"
scope="branch"
focus="认证、数据丢失、竞态条件和缺失测试"
model="grok-4.6"
```

## 11. 普通代码目录与 Git 仓库

普通目录可以使用：

- 环境诊断；
- 只读调查；
- 代码修改；
- 计划、文档和媒体生成；
- SHA-256 快照、范围校验、测试和回滚。

以下能力通常要求 Git 仓库：

- 分支或工作树审查；
- PR 审查和评论；
- Git worktree；
- 设计计划的多 PR 执行；
- PR babysit 和 CI 循环。

普通目录不要要求 Grok “审查当前分支”或“创建 worktree”。可以改为普通只读分析或
受限写入任务。

## 12. 权限与责任边界

Codex 可以在用户授权和 Codex 沙箱范围内使用宿主能力。Grok worker 被明确禁止：

- 调用其它 Codex MCP 或插件；
- 使用 Codex 浏览器、Chrome 会话或连接器；
- 读取 Codex、OpenAI、GitHub、XAI 和常见云服务凭据；
- 运行 `codex`、`gh`、`ssh`、`curl` 等宿主或网络命令；
- 通过 Grok MCP、子代理、memory 或 hooks 扩展权限；
- 自主提交 PR、上传文件或执行外部发布。

需要这些能力时使用以下交接：

```text
Codex 执行宿主步骤
  -> 提取最少且经过清理的必要信息
  -> Grok 执行受限项目工作
  -> Codex 检查 contract 和实际变更
  -> Codex 执行最终宿主或外部操作
```

在 Windows 上，插件使用 Grok 工具权限、配置预检、凭据路径拒绝、命令守卫、
SHA-256 快照、范围检查、测试和回滚。这里不宣称具有 Linux/macOS 内核级隔离或
虚拟机隔离。

## 13. 数据与日志

调用外部 Grok 模型时，任务提示以及 Grok 被授权读取的项目内容可能会发送到模型
上游。只应处理自己有权提供给外部模型的项目。

插件的持久工具事件日志只记录：

- 工具名称；
- 文件路径；
- 执行状态。

不会在工具事件日志中保存实际文件正文。任务结果仍可能包含必要的 Grok 回答、错误
诊断、用量和经过结构化处理的验证信息。

每个任务还会在插件状态目录保存一个追加式生命周期日志 `${jobId}.events.ndjson`。
它与 Grok 工具流日志不同，记录的是 harness 状态，例如：任务接受、策略确定、快照完成、
进程启动/退出/输出关闭、取消请求、验证、回滚和最终完成或失败。多个进程同时写入时，
`seq` 仍连续；敏感字段会被替换，单行最多 16 KiB。现有 schema-v3 job/status/result JSON
继续作为兼容投影，不需要旧调用方改读取方式。

任务结果中的证据分为：

- `workerPolicy`：兼容旧版本的最终策略摘要；
- `policyEvidence`：调用方请求、插件强制上限、实际生效策略和 SHA-256 指纹；
- `invocation`：一次调用的 MCP request、job、工具和模型身份；
- `executionEnvironment`：当前 Codex 工作区、目标工作区、真实执行工作区、根目录集合和环境 ID。

Personal 模式的真实执行工作区是临时脱敏副本，因此它会与目标工作区不同；任务完成后该
临时目录会被删除。以上证据不保存 prompt、文件正文、环境变量值或凭据，也不代表 Windows
获得了额外的内核级沙箱。

## 14. 无人值守使用边界

插件支持在一次已授权调用中自动完成：

- Grok 后台执行；
- 文件变更记录；
- 测试命令；
- 完成契约；
- 失败回滚；
- 后台结果持久化。

但以下外部故障仍可能使任务失败：

- CC Switch 上游账号额度耗尽或 `429`；
- Grok/代理认证失效或 `401`；
- 网络中断；
- Codex App 被关闭；
- 测试命令本身错误或超时；
- 用户要求的文件范围无法满足；
- 需要新的登录、审批或外部权限。

因此“无人值守”是指单个边界清晰的任务不需要人工逐步批准 Grok 的项目操作，不代表
插件可以绕过登录、网络、额度和宿主权限限制。

## 15. 常见问题

### 15.1 技能列表没有 Grok Auto

1. 确认 `codex plugin list` 显示插件 `installed, enabled`；
2. 重启 Codex App；
3. 创建新 task；
4. 输入 `/` 后重新查找 `Grok Auto (Standard)` 或 `Grok Auto (Personal)`。

旧 task 不会自动加载重装后的技能和 MCP 进程。

### 15.2 `GROK_MCP_TOOL_NOT_LOADED`

说明当前 task 没有加载插件 MCP。确认插件启用后，重启 App 并新建 task。不要在旧
task 中通过 PowerShell 模拟 MCP 工具存在。

### 15.3 `grok-companion.mjs MODULE_NOT_FOUND`

通常是旧缓存、不完整安装或旧 MCP 进程。重新执行：

```powershell
$codexCmd = Join-Path $env:APPDATA 'npm\codex.cmd'
& $codexCmd plugin add 'grok-codex-worker@grok-codex-worker'
```

然后重启 App 并新建 task。

### 15.4 Grok CLI 未找到

确认：

```powershell
Test-Path (Join-Path $env:USERPROFILE '.grok\bin\grok.exe')
```

插件支持从常见安装路径查找 `grok.exe`，也可以设置 `GROK_BINARY` 指向实际程序。

### 15.5 `401 Invalid or expired credentials`

`grok doctor` 通过不代表模型请求一定通过。应直接执行本手册第 2 节的 Grok 4.6
固定响应测试。检查 Grok 配置模型名称、CC Switch 本地端口、上游格式和认证路由。

### 15.6 `429`

通常表示 CC Switch 第三方上游的账号池限额、并发限制或临时容量问题。插件应报告
失败，不应放宽安全策略。恢复上游后再进行有界重试。

### 15.7 写入任务显示 0 个变更

插件会判定完成契约失败。Grok 的文字说明不能代替真实落盘。检查提示是否明确要求
写入，目标文件是否已经包含同名测试，以及回合上限是否过低。

### 15.8 范围违规并回滚

说明 Grok 修改了 `allowedChangedFiles` 外的文件，或者触碰了
`forbiddenChangedPaths`。回滚是预期保护行为。应缩小任务、先做只读调查，或在确认
确有必要后准确调整白名单；不要为通过任务而放开整个项目。

### 15.9 `grok_plan` 与“完全只读”冲突

`grok_plan` 需要写入 `.grok-plans/`。Personal 的完全零写入分析应改用：

```text
grok_personal_read
```

Standard 模式可继续使用 `grok_rescue + readOnly=true`。

### 15.10 `NO_COLOR` doctor 提示

这通常只影响终端颜色，不影响 Grok 模型请求。判断能否工作应以固定响应模型请求和
插件 `ready=true` 为准。

### 15.11 提示不支持 custom agents/cross-session memory

如果请求没有传 `agent` 或启用 memory，却仍在 Grok 启动前出现此错误，通常说明当前
task 仍连接着修复前的 MCP 进程。重新安装最新版插件、完全退出并重启 Codex App，
然后创建新 task；旧 task 不会切换到新的插件进程。

## 16. 更新开发版本

修改插件源码后，不能直接编辑 Codex 安装缓存。应更新 cachebuster 并重装：

```powershell
python `
  C:\Users\windows\.codex\skills\.system\plugin-creator\scripts\update_plugin_cachebuster.py `
  E:\APP\CodexProject\grok-codex-worker\plugins\grok-codex-worker

$codexCmd = Join-Path $env:APPDATA 'npm\codex.cmd'
& $codexCmd plugin add 'grok-codex-worker@grok-codex-worker'
```

验证：

```powershell
npm.cmd test
node --test tests/installed-cache.test.mjs
python `
  C:\Users\windows\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py `
  E:\APP\CodexProject\grok-codex-worker\plugins\grok-codex-worker
```

`installed-cache.test.mjs` 会按源插件 manifest 的精确版本定位真实安装缓存，比较全部
插件文件的 SHA-256，然后从缓存目录启动 MCP server，并用 mock Grok 验证当前项目、
外部未授权拒绝和外部精确授权三条路径，同时核对 invocation、策略指纹、执行环境身份和
连续事件日志。缓存尚未安装时该项会明确跳过；重装后必须通过。

然后重启 Codex App 并创建新 task。

## 17. 快速参考

普通用户推荐流程：

```text
1. 打开项目的新 task
2. 输入 /
3. 选择 `Grok Auto (Standard)`；需要个人源码脱敏外发时选择 `Grok Auto (Personal)`
4. 输入 on 和实际任务
5. Codex 自动决定是否调用 Grok
6. 查看 Codex 对变更、测试和 verified 的最终审核
7. 不再需要时选择同一技能并输入 off
```

最常用状态命令：

```text
$grok-auto on
$grok-auto once
$grok-auto status
$grok-auto off
```

最重要的原则：

> Codex 负责决策、权限和最终审核；Grok 负责受限的项目工作；实际文件变化和测试证据
> 比模型的文字说明更可信。
