# dsh-engineering-skills — 需求与契约基线

- 状态：**v0.1.2**（实现与验收以此文件为准；改服务/事件/字段契约前先改这里）
- 验证目标：DeepSeek Harness（dsh）`0.2.1-rc.2`（desktop / web profile）
- 上游：`mattpocock/skills` v1.3.1 @ `5beb35b`（见 `UPSTREAM.json`）
- 契约来源：`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-tool-skill`、`@deepseek-ai/dsh-skill-filesystem` 的包内 README 与实现（harness 内置于 app.asar / npm 同名包）

## 1. 目标

把上游 27 个 engineering / productivity 技能，作为一个 **bundled skill provider 插件**分发：

- `dsh plugin add` 后 27 个技能出现在 `/` 菜单；其中 11 个 model-invocable 进模型 catalog，16 个 user-invoked 仅用户可调；
- 卸载/停用插件即整体移除，不写用户 `~/.agents/skills`，不依赖工作区目录；
- 上游内容可重复同步（`scripts/sync-upstream.mjs`），改写只允许机械规则；
- 无构建步骤：`lib/` 是可运行 ESM，`skills/` 是数据；git 安装不触发 `prepare`。

## 2. 已确认契约（变更需同步测试）

### 2.1 包与 bundle

| 项 | 契约 |
|---|---|
| 包名 / 插件 identity | `dsh-engineering-skills` / `engineering-skills` |
| bundle 声明 | `package.json` → `dsh.bundle.patch: ./cordis.patch.yml` |
| patch 内容 | YAML 数组，含 `- insert: [{ id: engineering-skills, name: dsh-engineering-skills }]` |
| 安装单位 | profile bundle（`dsh plugin --profile <p> add github:tianji-qingtian/dsh-engineering-skills#<tag>`） |
| 运行时文件 | `lib/`、`skills/`、`cordis.patch.yml`、`UPSTREAM.json`、`NOTICE`、`LICENSE`、`LICENSE-upstream` 必须在 `files` 白名单内 |
| 版本门禁 | peer `@deepseek-ai/dsh-skill ^0.2.1-rc.2`（harness 安装/启动时校验；prerelease 需显式匹配，升 harness 必升 peer） |

### 2.2 技能提供者

- 服务：`ctx.skills`（`dsh-skill` 注册表），必须硬注入 `inject: ['skills']`。
- 注册：`apply(ctx)` 内用 `ctx.effect(function* () { yield ctx.skills.registerProvider(() => provider) })`，
  **不得裸调 `registerProvider`**——注册 effect 会挂在注册表自己的 ctx 上，插件停用/热重载后
  provider 残留、重新挂载因重名失败。
- provider：`{ name: providerName, list(): Promise<Candidate[]>, get(candidate, options): Promise<Definition> }`。
- candidate 字段：`name`（kebab-case）、`description`（非空）、`invocation: { modelInvocable, userInvocable }`、
  `source: 'bundled'`、`rank: 600`（`BUNDLED_SKILL_RANK`）、`provider`（= provider.name）、
  `resourceBase: { kind: 'directory', path }`、`locator: <SKILL.md 绝对路径>`。
  **不设 `path`**：bundled 技能的 SKILL.md 在 profile `node_modules` 内，客户端工作区预览打不开。
- definition：candidate 摘要 + `content`（去掉 YAML frontmatter 的正文）。
- 调用策略映射：上游 `disable-model-invocation: true` → `{ modelInvocable: false, userInvocable: true }`；
  默认 → `{ modelInvocable: true, userInvocable: true }`。`/name` 手势是 user-invoked 技能的入口，不注册 commands。

### 2.3 内容与上游

- 唯一推广集 = 上游 `.claude-plugin/plugin.json#skills`（27 个）；`in-progress/`、`misc/`、`deprecated/` 永不发布。
- 只允许这些机械改写（见 `NOTICE`，`scripts/sync-upstream.mjs` 为唯一执行者）：
  正文 `Skill tool` → `` `skill` tool ``；frontmatter 归一化（`description` 重引号；丢弃 `argument-hint`/`metadata`/未知键）；
  不 vendored `agents/openai.yaml` 与 bucket README。
- `skills/**` 不得手改；改内容 = 改上游 pin → `sync` → 提交生成树。
- `UPSTREAM.json` 的 `version` 必须与上游 `package.json` / `.claude-plugin/plugin.json` 一致，`--check` 会校验。

### 2.4 配置

| 字段 | 默认 | 语义 |
|---|---|---|
| `providerName` | `engineering-skills` | 注册表 provider 名；重名导致挂载失败 |
| `categories` | `[engineering, productivity]` | 类别过滤；未知值挂载失败；**`skills` 非空时忽略本项** |
| `skills` | `[]` | 显式技能名子集；非空时**覆盖** `categories`；未知名挂载失败 |
| `appendHarnessGuide` | `true` | 加载时追加 DSH 工具映射段；false 时不追加 |

### 2.5 生命周期

- 插件 fiber dispose（停用 / HMR 重载 / 卸载）→ provider 注销，目录立即消失；
- 重新挂载同一插件必须成功（不得出现 provider 重名）；
- `test-registry.mjs` 用真实 `SkillRegistry` + cordis 覆盖这两条。

## 3. 验收清单（可执行）

```sh
pnpm install --frozen-lockfile
pnpm test                 # test-host 23 项 + 真实 registry/lifecycle + bundle/打包契约
pnpm run sync:check       # 上游漂移 + pin 版本校验
pnpm pack                 # 运行时文件齐全（CI 另做 tarball 解包 + import 冒烟）
```

人工验收（每次发版）：

1. `dsh plugin --profile <p> add "github:tianji-qingtian/dsh-engineering-skills#<tag>"` 成功，`--dump-config` 含插件行；
2. 重启后 `/` 菜单 27 条：16 条带「仅用户」前缀，11 条双通道；模型 catalog 11 条；
3. `/{user-invoked 技能}` 能直接注入正文；`skill` 工具能加载 model-invoked 技能并带 base directory；
4. profile patch 配 `categories: [productivity]` + `skills: [tdd]` 时只出 `tdd`（覆盖语义）；
5. 插件页停用该插件 → `/` 菜单技能消失；重新启用 → 恢复。

## 4. 不变量

- 不写用户技能目录（`~/.agents/skills`、`~/.claude/skills`），不依赖工作区 `.dsh/skills`。
- 不改上游散文（只允许 §2.3 的机械规则）；每处改写都要在 `NOTICE` 可追溯。
- 技能内容按需加载：catalog 只放 name+description，不内联正文。
- 无构建、无运行时依赖（除 schemastery + harness 提供的 dsh-skill/cordis）。

## 5. 非目标 / 已知边界

- **不改写**技能语义。`ask-matt`（要求模型读其它 user-invoked 正文）、`implement-spec`（并行 worktree）、
  `triage`/`wayfinder`（外部 tracker）、`improve-codebase-architecture`（CDN HTML）、temp/`open` 等已知差异
  保持上游原文，由 README「已知边界」向用户说明；要修需单开需求。
- 不注册 commands、不加投影/UI、不接管模型路由。
- 不支持嵌套技能目录；不发布 `in-progress/` 等非推广桶。

## 6. 变更记录

| 版本 | 变更 |
|---|---|
| 0.1.0 | 首个发布：27 技能 bundled provider、category/skills 配置、sync 脚本、CI/release |
| 0.1.1 | 修复 `skills` 覆盖 `categories` 的语义；provider 注册绑定插件 fiber（停用/重载生效）；async 测试断言；删除候选 `path`；上游 MIT 全文（`LICENSE-upstream`）+ NOTICE 改写清单；`--check` 校验 pin 版本；pnpm 11.28.5 + lockfile、pack 冒烟 |
| 0.1.2 | 契约基线（本文件）；`sync-upstream.mjs` 拆分 `adaptSkill`/`buildManifest`/`build`；移除未消费的 `whenToUse`；CI 增加 bundle/patch 解析与 tarball 解包 import 冒烟 |
