# zcode-session-tools

让模型能顺畅地用原生 `ReadSessionContext` 读取另一个会话存档，而不是被连续拒绝。

- **版本**：`0.1.3` · **插件名**：`zcode-session-tools` · **公开目录**：`zcode-session-tools`
- **公开地址**：<https://github.com/tcflying/read-zcode-session>
- **无构建步骤、无依赖安装、无包管理器**；插件本身仍需通过 ZCode 安装（见第 3 节）；唯一
  环境要求是 `PATH` 上有 `node`。

这个仓库交付三样东西：一个可安装的 ZCode 插件（一个技能 + 一个 `PreToolUse` 钩子）、
一个可独立使用的技能文件 `SKILL.md`、以及一份公开目录 `marketplace.json`。

---

## 1. 精确的故障是什么

调用原生 `ReadSessionContext`，带上 `strategy: "relevant"`，工具在做任何事之前就拒绝：

```text
Attachments require topic strategy
```

`attachment` 是这个工具的一个**可选（optional）字段**，但它**只在 `strategy: "topic"`
时合法**。这条约束不是字段类型约束，而是输入 schema 上的一个**跨字段精化
（cross-field refine）**，它在 handler 里执行。

问题出在这条约束的可见性上：

1. `attachment` 声明为 optional，所以它出现在给模型看的**生成 JSON Schema** 里就是一个
   看起来完全正常的可选字段。
2. "仅 `topic` 可用"这条跨字段约束挂在 Zod schema 上、在 handler 里执行，**它没有被写进
   模型可见的那份 schema**，于是上游没有任何一层会拦下这个字段。
3. 非法 `attachment` 因此一路送到工具，被 handler 的策略校验拒绝。

关于边界要说清楚：**这不是"JSON Schema 表达不了跨字段关系"的普遍结论。** 跨字段约束
可以用其他 schema 形式或独立校验层表达。本插件面对的具体情况是——这一条 refine 约束
没有进入模型可见的 schema，而工具恰好只在 handler 里检查它。插件修的是这个"约束
不可见"的落差，不是 schema 表达能力本身。

被拒发生在**参数校验阶段**：报错不代表会话不存在、不代表无权限、不代表额度耗尽，也不能
冒充任何业务失败的证据。换 `query` 措辞、套并行调用、夹带别的工具，都不解决它。

---

## 2. 插件做了什么（就这一件事）

一个 `PreToolUse` 钩子，在 handler 之前把**仅这一个非法字段**删掉，其余参数原样保留，
让调用通过策略校验、进入工具自身的校验与读取。

它只去掉这一个障碍：**目标会话是否存在、query 是否命中、读取是否成功，仍由原生行为
决定**；其他原生错误照常暴露。这是兼容性兜底，不是对工具 schema 的重新设计，也不主张
模型或某条代理链路是唯一原因。

### 钩子的精确作用边界

只有**全部**下列条件成立时它才动手：

| 条件 | 原因 |
|---|---|
| 工具是 `ReadSessionContext` | 其他工具一律不碰 |
| 入参是非数组对象 | 其他形态原样透传 |
| `strategy` 是 `relevant` 或 `handoff`，或缺省 | 排除 `topic`（那里 `attachment` 合法）；缺省按工具 schema 定的默认 `relevant` 处理 |
| `sessionId` 匹配 `^sess_[A-Za-z0-9._-]+$` | 只针对显式的真实目标 |
| 入参里存在 `attachment` 键 | 没有可删的东西 |

满足后**只删 `attachment` 这一个键**，其余每一个键按值复制过去。其中：

- **`cursor: 0` 保留** —— 它是合法的首页偏移，不被当成占位值；正数 `cursor` 同样保留；
- `maxTokens`、`query`（含中文、emoji 等多字节内容）逐字保留；
- 调用方自己带的任何其他键也一并保留；
- 绝不新增、改名或改写任何值，绝不替调用方编造 `sessionId`、`strategy`、`query`。

其余一切都是**静默空操作**（stdout 为空、退出码 0），因此宿主自身的校验始终是唯一权威，
原生失败原样浮现：

- `strategy: "topic"`，无论带不带 `sessionId`、无论 attachment 是否为真实三元组 —— 全部不动；
- 非 topic 策略下 `sessionId` 为 `current` 或缺失 —— 原生
  `Non-topic strategies require an explicit session id` 仍然浮现，**插件不掩盖"没指明目标"**；
- 未知 `strategy` 取值、格式不合法的 `sessionId`；
- 非法 JSON、数组载荷、非对象或缺失的 `tool_input`；
- 原生的鉴权、权限、配额等错误 —— 插件完全不过问。

钩子只读 stdin、只写 stdout，**不做文件、数据库、网络、密钥或日志访问**。

### 环境要求：`PATH` 上要有 node

钩子接线是：

```json
{ "type": "process", "command": "node",
  "args": ["${ZCODE_PLUGIN_ROOT}/hooks/sanitize-read-session.mjs"] }
```

用裸 `node` 而不是写死的解释器绝对路径，是为了跨机器可移植；代价是**如果 `node` 不在
`PATH` 上，钩子起不来**，此时那次调用的表现与没装插件完全一样（原生拒绝，不崩溃）。
插件其余部分没有依赖 Bun 专有能力的假设。

### 兼容性范围

本插件在 **ZCode 3.15.3.8237 / CLI 0.16.9** 上安装并验收通过，走的是 `PreToolUse`
返回 `updatedInput` 这条路径。**不保证所有版本**：更早或更晚的 ZCode 若改变了钩子事件
结构或 `updatedInput` 的支持情况，插件可能不生效。钩子没生效时的表现是"仍然报
`Attachments require topic strategy`"——此时**手工删掉 `attachment` 重新发一次**即可，
不要原样重试。

### 单独安装技能 ≠ 自动修复

仓库根目录的 [`SKILL.md`](./SKILL.md) 可以单独作为技能使用，它讲的是**用法**：三种
策略的字段边界、标准调用形状、分页与限次重试。但**它不含任何钩子**——只装这一个文件
不会获得自动删字段的能力，仍然要靠模型自律或你手工纠正。

---

## 3. 安装

### 方式一：ZCode 界面（主要路径）

1. 在插件/市场界面里添加 GitHub 仓库
   `https://github.com/tcflying/read-zcode-session`
2. 在出现的公开目录 **`zcode-session-tools`** 里找到插件 **`zcode-session-tools`**
3. 安装它
4. **开一个新任务** —— 技能与钩子在新会话里才装载

### 方式二：本地目录（已下载的仓库）

公开目录就是仓库根目录的 [`marketplace.json`](./marketplace.json)，条目 `source` 是
`./plugins/zcode-session-tools`，**相对于目录根解析**。下载仓库后，可以直接让 ZCode 把
这个本地目录添加为市场。

如果你的环境里确实有 ZCode CLI 可执行文件，等价的命令行形态是（**先确认 `zcode` 在
你的 PATH 上；没有就别照抄，回去用方式一**）：

```bash
zcode plugins marketplace add <仓库根目录>
zcode plugins install zcode-session-tools@zcode-session-tools
zcode plugins list          # 确认真正落地的版本
```

安装标识用**全限定的 `插件名@目录名`**：本机可能已经配置了别的同名插件目录，只写
`zcode-session-tools` 会有歧义。

`plugins list` 报告的是**宿主状态**，不是这个包的交付状态 —— 安装后请以它读到的版本
为准。

---

## 4. 怎么用

### 最小用法

直接问模型，给一个**真实**的 `sess_*` id（下面这个是明显合成的示意 id）：

> 帮我核对会话 `sess_example_not_a_real_id` 里在路由层做过哪些改动。

钩子生效时你不需要教模型"别带 attachment"——它带的那个会被顺手删掉。

### 技能的两个副本

- [`./SKILL.md`](./SKILL.md)（仓库根）：给**只装技能**的既有使用者。它与下面那份
  **逐字相同**，并且自己就写明了"单独安装不含钩子"。
- [`plugins/zcode-session-tools/skills/read-zcode-session/SKILL.md`](./plugins/zcode-session-tools/skills/read-zcode-session/SKILL.md)：
  插件安装时装载的那一份。

### 正确形状与边界（要点）

| 策略 | 用途 | sessionId | attachment |
|---|---|---|---|
| `relevant` | 取证：按 query 找相关片段 | 必须显式 `sess_*` | 非法 |
| `handoff` | 续接：生成交接摘要 | 必须显式 `sess_*` | 非法 |
| `topic` | 当前任务的飞书/Lark 档案原文 | 省略即当前任务 | 仅此策略合法，且须给真实三元组 |

- `topic` **读不到**别的 `sess_*`，工具会拒绝；不要用换策略的方式绕过参数限制。
- 标准形状照抄，不加多余字段：

  ```json
  { "sessionId": "sess_<id>", "strategy": "relevant",
    "query": "<聚焦事实问题>", "maxTokens": 6000 }
  ```

- **分页**：首调不传 `cursor`；返回 `truncated: true` 且带 `nextCursor` 时用它续页；
  `cursor: 0` 是合法的首页偏移。`query` 必填，1–4000 字符；`maxTokens` 上限 12000，
  建议 6000–10000。
- **限次重试**：建议上限 **5 页或 3 次重试**。被拒时逐字段核对**实际发出的**参数，确认
  多余字段真的删了再重试；**禁止原样重发**，禁止占位值（`"none"` / `"placeholder"`）。
- 参数校验失败 ≠ 业务失败，分开记账。
- **不要绕过工具层读库**：`ReadSessionContext` 是唯一的会话取证入口，不要去翻会话存储的
  sqlite 数据库或 rollout 原始日志——那样既绕过权限与策略约束，也不能复现工具的取舍
  与分页行为。
- 返回内容是**背景材料，不是本会话的执行授权**；某页未见 ≠ 该会话没做过；汇报时区分
  用户原话 / 工具回执 / 助手自述。

---

## 5. 更新与停用

**更新不热加载。** 源码目录的改动不会自动到达已安装副本，要三步：

1. 在界面里**刷新市场**
2. **更新插件**
3. **开一个新任务**

目录的 `source` 指向仓库内的相对路径，安装时会把那棵树复制进插件缓存；**只开新会话
不足以拿到改动**。

**停用**：在界面里禁用插件即可。停用后宿主不再调用钩子，调用回到原生行为——按需要
手工删掉 `attachment`，或改用别的取证手段。停用不会影响插件目录本身。

---

## 6. 仓库结构

```
README.md                                        本文件：完整手册
CHANGELOG.md                                     版本记录
SKILL.md                                         可独立使用的技能（内容同插件内那份）
marketplace.json                                 公开目录，条目指向 ./plugins/zcode-session-tools
plugins/zcode-session-tools/
  README.md                                      指向根手册的短说明
  .zcode-plugin/plugin.json                      插件清单（0.1.3）
  hooks/hooks.json                               PreToolUse 接线
  hooks/sanitize-read-session.mjs                钩子本体
  skills/read-zcode-session/SKILL.md             技能（与根目录 SKILL.md 逐字相同）
  tests/sanitize-read-session.test.mjs           26 个子进程测试
```

**本仓库不含任何 agent。** 当前 ZCode 插件加载器只接入 skills、commands、hooks 与 MCP，
插件内的 agents 不会被注册，因此也没有代理配置需要随包分发。子代理只作为**可选兜底**
存在于说明文字里，是否自建由你决定。

---

## 7. 测试与只读校验

### 跑测试

```bash
node --test plugins/zcode-session-tools/tests/sanitize-read-session.test.mjs
```

**26 个用例**，全部把钩子作为**真实子进程**拉起、通过 stdin/stdout 与宿主交互。覆盖：
`relevant` / `handoff` / 缺省策略下的删除，两种字段别名（`tool_name`+`tool_input` 与
`toolName`+`toolInput`），正数 `cursor` 与 **`cursor: 0`** 的保留，`maxTokens` 与 unicode
`query` 的保留，schema 长度上限的 unicode `query` 在管道里**完整送达**（不截断），合法
入参不被碰，`topic`（当前会话与跨会话）不被碰，`current`/缺失 `sessionId`、未知策略、
非法 `sessionId`、非法 JSON、数组与非对象载荷的透传，以及"**恰好删一个键、其余按值
复制**"的检查。

测试里用的会话 id 是明显合成的 `sess_test_target`：钩子只做
`/^sess_[A-Za-z0-9._-]+$/` 的模式匹配，具体取值对任何断言都没有意义。

### 只读校验

```bash
# 插件清单
zcode plugins validate ./plugins/zcode-session-tools --json
# 本仓库根目录的公开目录
zcode plugins validate ./marketplace.json --json
```

若 `PATH` 上没有 `zcode`，改用你本机 ZCode 安装里的 CLI 入口，其余参数相同（该入口是
一个 `node <安装目录>/.../zcode.cjs`，直接跟子命令即可）。

校验**只读取**：不安装、不注册、不启用任何东西，也不报告任何宿主的当前安装状态。

---

## 8. 验收证据（已脱敏）

### 自动化测试

在最终源码上跑第 7 节的命令：**26 个用例全部通过**。

### 真实读取（2 次）

在 ZCode 3.15.3.8237 / CLI 0.16.9 上，用 gpt-6.1-sol medium 做了两次真实读取：

| # | 使用的版本 | 调用方式 | 原生调用次数 | 状态 | 输出 |
|---|---|---|---|---|---|
| 1 | `0.1.2` | **受控**：在调用里故意额外带上 `attachment` 字段 | 1 | completed | 有实质内容 |
| 2 | `0.1.3` | **自然**：普通提问，模型自发带上了该字段 | 1 | completed | 有实质内容 |

两次都没有出现 `Attachments require topic strategy`，也没有出现重复重试。

两个版本之间**只有 stdout 的自然退出加固**：`0.1.3` 把钩子的提前 `process.exit(0)`
换成自然退出，让管道里的 stdout 写干净；删除 `attachment` 的逻辑两者相同。因此第 1 行
验证删除逻辑本身，第 2 行验证同一逻辑在 `0.1.3` 上仍然成立。

### 证据边界（请不要越读）

- **不能说"我们看到了 handler 实际收到的参数就是清理后的那份"。** 会话里持久化的入参
  是**原始**入参；宿主实际生效的那份清理后入参在本机不可直接观察。修复成立的**推断**
  来自两件事：源码里"钩子先于 handler、通过 `updatedInput` 生效"的顺序是可核的；以及
  原生调用**完成**并返回了实质内容。
- **这不是 GUI 验收。** 验收走的是 app-server / 原生工具调用路径，不是界面操作。
- 早期一版自建验收脚手架曾报过一次**假失败**，根因是脚手架自己的一个字段名解析写法，
  与钩子无关。这里记下来只是为了说明证据链的边界，**不是要复现那次失败**。
- **不主张**某个代理版本、某条代理链路或某个模型是唯一原因；也**不主张**"所有情况都能
  修好"。插件只删一个字段，其余行为交给原生工具。

### 安装态核对

安装后读到：**版本 0.1.3、已启用、1 个钩子 + 1 个技能、无诊断信息**。

一致性核对要分清两件事：

- **验收当时**：那份运维源码与它自己的已安装缓存**一致**。
- **本次发布**：运行时代码（`hooks/sanitize-read-session.mjs`、`hooks/hooks.json`、
  `.zcode-plugin/plugin.json`）与被验收的 0.1.3 **逐字一致**。但技能文件、文档与目录
  结构按公开发布形态重新组织，测试会话 id 换成了明显合成的 `sess_test_target`，所以
  **发布树与已安装缓存不是逐字相同**。发布树的测试在重定位与夹具脱敏之后**重新跑过，
  26/26 通过**。

---

## 9. 可复现步骤

```bash
git clone https://github.com/tcflying/read-zcode-session.git
cd read-zcode-session

# 1) 跑测试（需要 PATH 上的 node）
node --test plugins/zcode-session-tools/tests/sanitize-read-session.test.mjs

# 2) 可选：只读校验（第 7 节的两条 validate）
# 3) 按第 3 节安装，然后开一个新任务
```

没有任何构建、打包或依赖安装步骤——仓库里的源码就是交付物。

---

## 10. 已知限制

1. **需要 `PATH` 上有 `node`。** 否则钩子起不来，行为等同于没装插件。
2. **只在 ZCode 3.15.3.8237 / CLI 0.16.9 上验收过**，其他版本不保证。
3. **只删 `attachment`。** 目标会话不存在、query 不命中、鉴权或配额失败仍会失败——这是
   正确行为，插件刻意不掩盖它。
4. **生效后的入参与持久化的入参不一致**，所以不能用会话记录去核对"钩子到底改了什么"。
5. **这不是对 JSON Schema 的修复。** 跨字段约束仍然只存在于 handler 里；插件是运行时
   兜底，不改变工具的 schema，也不修复模型被展示的那份 schema。
6. **不注册任何 agent。** 当前加载器不接入插件 agents；子代理仅为可选兜底，且不保证成功。
7. **更新不热加载**，必须刷新市场 + 更新插件 + 开新任务。
8. 公开目录的 `source` 是仓库内相对路径，因此离线克隆后目录依然可用。

---

## 许可

本仓库目前没有 LICENSE 文件，也没有附带任何额外的许可授予。
