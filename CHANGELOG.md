# 更新记录

## 0.1.3

本插件的首个公开发布版本。

### 修复

- **最小修复**：在 `relevant` / `handoff` 策略（含缺省策略）下，对显式 `sess_*` 目标的
  `ReadSessionContext` 调用，`PreToolUse` 钩子只删掉 `attachment` 这一个字段，其余键按值
  复制，使调用不再被 `Attachments require topic strategy` 拒绝。`topic` 一律不动，
  `cursor: 0`、未知策略、非法/缺失 `sessionId`、非法 JSON 等全部静默透传，原生错误照常
  暴露。

### 加固

- **stdout 自然退出**：钩子不再提前调用 `process.exit(0)`，改为让进程自然退出，以便
  Node 把管道中的 stdout 写干净。
  **需要说明**：本次并未复现出任何输出截断故障。回归测试里那条"schema 长度上限的
  unicode query 完整送达"的断言在旧的提前退出实现下同样通过——所以它是守住投递完整性的
  护栏，**不是**曾经存在过的故障的证明。

### 发布形态

- 公开目录 `zcode-session-tools` 位于仓库根，条目指向 `./plugins/zcode-session-tools`。
- 仓库根的 `SKILL.md` 与插件内的那份**逐字相同**；单独安装技能只提供用法约束，**不含
  钩子**。
- 不分发任何 agent：当前插件加载器不注册插件内的 agents。
- 26 个子进程测试随包发布，全部使用明显合成的会话 id。
