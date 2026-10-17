# zcode-session-tools（插件目录）

这是公开插件 `zcode-session-tools` 的源码目录，版本 `0.1.3`。

完整说明——问题根因、钩子的精确作用边界、安装与更新方式、测试与验收证据、已知限制
——都在仓库根目录的手册里：
<https://github.com/tcflying/read-zcode-session#readme>。本文件只是一条指路，不重复
内容。

## 本目录内容

```
.zcode-plugin/plugin.json            插件清单（0.1.3）
hooks/hooks.json                     PreToolUse 接线
hooks/sanitize-read-session.mjs      钩子本体
skills/read-zcode-session/SKILL.md   用法规程（与仓库根目录 SKILL.md 同一份）
tests/sanitize-read-session.test.mjs 26 个子进程测试
```

安装入口是仓库根目录的公开目录（<https://github.com/tcflying/read-zcode-session>）里的
`marketplace.json`，其条目 `source` 指向本目录。

本目录不附带任何 agent：当前 ZCode 插件加载器只接入 skills、commands、hooks 与
MCP，插件内的 agents 不会被注册，因此也没有配置代理需要随包分发。

跑测试（路径取决于你在哪个目录）：

```bash
# 在仓库根目录
node --test plugins/zcode-session-tools/tests/sanitize-read-session.test.mjs

# 或在本插件目录内
node --test tests/sanitize-read-session.test.mjs
```
