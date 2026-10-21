# dsh-engineering-skills

把 [Matt Pocock 的 skills 仓库](https://github.com/mattpocock/skills)（27 个 engineering / productivity 技能）做成一个 **DeepSeek Harness 插件 bundle**：`dsh plugin add` 装上，27 个技能当场出现在会话技能目录与 `/` 菜单里，卸载即干净移除。

> harness 仍在 developer preview，插件可能需要跟随升级。

> English: [README.md](README.md)。

## 截图

`/` 菜单里的技能建议：`grill-me`、`grill-with-docs` 带「仅用户」标记（模型不可自动调用），`grilling` 是 model-invoked（同时出现在模型 catalog 里）：

![slash menu](imgs/slash-menu.png)

## 为什么是插件，而不是直接拷文件

严格说，**不上插件也能用**：DSH 的 `dsh-skill-filesystem` 默认扫描 `~/.agents/skills`（rank 500）和项目内 `.agents/skills`（rank 200），上游自带的 `npx skills@latest add mattpocock/skills` 正好把技能铺到这两个目录，`SKILL.md` 格式与 `disable-model-invocation` 语义跟 DSH 完全兼容，装完就能用。

做成插件多出来的价值：

| 维度 | 直接拷文件 | 本插件 |
|---|---|---|
| 安装/卸载 | 手工 `npx skills add` 或复制目录 | `dsh plugin add` / `remove`，插件页可视管理 |
| 升级 | 手工重跑安装脚本 | 升 tag 即可；`scripts/sync-upstream.mjs` 钉住上游 commit，`--check` 防漂移 |
| 全局目录污染 | 写 `~/.agents/skills`，每个 agent 共享 | 只在本 profile 生效，不碰用户技能目录 |
| 目录成本 | 11 个 model 描述常驻 catalog（27 个都在 `/` 菜单） | 可按 category / 技能名裁剪，控制常驻 token |
| 词表适配 | 原文里的 `Skill tool` 等 harness 措辞 | 加载时补一段 DSH 工具映射（可关） |
| 多文件资源 | 依赖文件系统 base dir | 同左，但随包分发、版本一致 |

## 安装

### 前置条件

`dsh` CLI 必须在 `PATH` 上（`npm install -g @deepseek-ai/dsh`，或给命令加 `npx @deepseek-ai/dsh` 前缀）。本版本针对 harness `0.2.1-rc.2` 验证。

### 加 bundle

```sh
# 1. 装进 web profile（pnpm 驱动；lib/ 已随仓库提交，安装时不跑构建脚本）。
#    建议钉 release tag（#v0.1.1）；#main 跟踪最新提交。
dsh plugin --profile web add "github:tianji-qingtian/dsh-engineering-skills#v0.1.1"

# 2. 重启该 profile —— add 只改 profile 文件，运行中的实例不会热加载
dsh --profile web
```

重启后 `/` 菜单应列出全部 27 个技能（16 个仅用户 + 11 个双通道），模型 catalog 里应出现 11 个 model-invoked 技能。设置 → 插件 里能看到 `dsh-engineering-skills`。

开发/试用本地路径：

```sh
dsh plugin --profile web add <本地检出目录>/dsh-engineering-skills
```

## 配置

默认全部 27 个。需要控制 catalog 体积或只留某几类时，在自己的 profile patch 里覆盖：

```yaml
- id: engineering-skills
  config:
    categories: [productivity]          # engineering | productivity，默认两者
    skills: [grilling, grill-me, tdd]   # 显式名单，非空时覆盖 categories 过滤
    appendHarnessGuide: true            # 加载时追加 DSH 工具映射段，默认 true
    providerName: engineering-skills    # 注册到技能服务的 provider 名，默认 engineering-skills
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `providerName` | `engineering-skills` | 技能注册表中的 provider 名；重名会让挂载失败，改成别的即可 |
| `categories` | `[engineering, productivity]` | 上游两个推广桶；未知值直接挂载失败，不静默缩表（`skills` 非空时忽略本项） |
| `skills` | `[]` | 显式技能名子集；**非空时覆盖** `categories`（未列出的类别不参与过滤）；写错名字直接失败 |
| `appendHarnessGuide` | `true` | 关闭后只加载 vendored 正文，不追加 harness 指南 |

## 技能映射（上游 → DSH）

| 上游机制 | DSH 对应 | 备注 |
|---|---|---|
| `SKILL.md` 目录包 + YAML frontmatter | 同一格式，registry 解析 | `name` / `description` / `disable-model-invocation` / `user-invocable` 全支持 |
| `disable-model-invocation: true`（16 个） | `{ modelInvocable: false, userInvocable: true }` | 只出现在 `/` 菜单，进不了模型 catalog 与 `skill` 工具 |
| 默认（11 个 model-invoked） | `{ modelInvocable: true, userInvocable: true }` | 进 catalog，可 `skill` 加载，也可 `/name` 直接调 |
| `/name` 斜杠命令 | `/name` 手势（宿主侧注入同形态 `<skill_content>`） | 不需要注册 commands，DSH 原生支持 |
| `agents/openai.yaml` | 不随包分发（Codex UI 元数据，DSH 不读） | 同步脚本剔除 |
| 技能内引用子文件（25 个） | `resourceBase: { kind: 'directory' }` | `skill` 结果带 base directory，模型按需读 `references/*` |
| `Skill tool` 措辞 | 同步脚本改写为 `` `skill` tool `` | 唯一的内容级替换 |

## 上游同步

`UPSTREAM.json` 固定仓库、版本、40 位 commit；`skills/` 完全由脚本生成：

```sh
node scripts/sync-upstream.mjs                  # 按 UPSTREAM.json 的 commit 重新拉取并重建 skills/
node scripts/sync-upstream.mjs --source ../mp-skills   # 用本地已有 clone，省一次网络
node scripts/sync-upstream.mjs --check          # CI：skills/ 与 pin 不一致就 fail
```

`--check` 还会校验 `UPSTREAM.json` 的 `version` 与上游 `package.json` / `.claude-plugin/plugin.json` 声明是否一致，版本字符串不能靠"抄进 manifest"自证。

发版流程：改 `UPSTREAM.json` 的 `version`/`commit` → `sync` → 跑 `pnpm test` → 打 tag。上游新增技能只在它的 `.claude-plugin/plugin.json` 里出现时才会被带上，`in-progress/`、`misc/` 永不发布。

## 已知边界（诚实清单）

- **`ask-matt` 需要降级**：它要求"先读其它 user-invoked 技能的 SKILL.md"，而 DSH 按设计不向模型暴露 `disable-model-invocation` 技能的正文与路径。建议改写为"人可读导航 + 让用户自己敲 `/x`"，这是唯一会改变技能语义的适配点。
- **`implement-spec` 的并行 worktree**：基础包没有 worktree 工具，需要 skills 正文自己用 `git worktree` 编排，或降级串行；`subagent` 可以并行，但"每个 ticket 一个 worktree"要手写。
- **`triage` / `wayfinder` / `to-spec` / `to-tickets` 依赖外部 tracker**：国内环境建议 `setup-matt-pocock-skills` 里选 **Local markdown**（`.scratch/`，零 CLI、零网络），`gh`/`glab` 只作可选。
- **`improve-codebase-architecture` 的 HTML 报告**用 CDN Tailwind/Mermaid，离线或内网会降级；建议改自包含 HTML（或预渲染 SVG）。
- **临时文件与打开方式**：原文里的 OS temp / `open` 在 workspace-write 沙箱下要改成工作区内目录 + `present`。
- **catalog 常驻成本**：11 个 model-invoked 的描述每轮常驻（约 0.6k tokens 量级），27 个技能全开时 `/` 菜单也变长；按需用 `categories` 裁。
- **中文输出**：27 个技能正文是英文；要中文回答就在项目 `AGENTS.md` 里写语言约定（DSH 会加载）。
- **harness 升级**：peer 范围 `@deepseek-ai/dsh-skill` 必须跟着运行时版本（prerelease 的 semver 规则要求显式匹配，例如 `^0.2.1-rc.2` 不匹配 `0.2.2-rc.1`），升级后第一件事是升 peer + 复跑 `pnpm test`。

## Harness 兼容性

- peer 只约束 `@deepseek-ai/dsh-skill`（harness 安装和 profile 启动时都会校验；范围不匹配的 bundle 会被直接跳过，表现为"升级后插件凭空消失、零报错"）。
- prerelease 的 semver 规则要求显式匹配：`^0.2.1-rc.2` 覆盖 `0.2.1-rc.2` 及后续 `0.2.x` 正式版，但**不覆盖** `0.2.2-rc.1` 这类新 prerelease——harness 升 prerelease 后第一件事就是升 peer 范围并复跑 `pnpm test`。
- 本包无需构建：`lib/` 是可运行的 ESM，`skills/` 是数据，git 安装不触发 `prepare`。

## 开发与测试

仓库用 pnpm `11.28.5` 管理（`packageManager` 字段，CI 同版本）；其它大版本可能重写 `pnpm-lock.yaml` 的格式，提交前请确认锁文件只有预期改动。

```sh
pnpm install
pnpm test                 # node test-host.mjs：23 项行为断言
node test-registry.mjs    # 对真实 @deepseek-ai/dsh-skill 注册表的集成测试
pnpm run sync:check       # 上游漂移检查
```

`test-host.mjs` 用假 `skills` 服务跑真实 `apply()`，并复刻 registry 的候选校验规则（kebab-case 名称、description 非空、invocation 布尔、provider 归属），防止某条技能 frontmatter 悄悄把整张目录打残。`test-registry.mjs` 用真实 `SkillRegistry` 走 `list()` / `get()`，证明 `skill` 工具那条加载路径能拿到正文；它还验证插件 fiber dispose 后 provider 真正注销、插件可重新挂载（防止停用/热重载后旧目录残留、重挂失败）。

## 许可

插件代码 MIT（`LICENSE`）；`skills/` 内容来自 Matt Pocock 的 MIT 仓库（完整许可见 `LICENSE-upstream`），归属、改写清单与固定来源见 `NOTICE` 与 `UPSTREAM.json`。
