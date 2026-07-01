# MivoCanvas — 版本管理规范

> 创建日期：2026-07-01
> 全局权威：`~/.claude/rules/project-versioning.md`
> 本文件是该全局规范在本项目的实例化。

## 1. Git 初始化清单

本项目由 `new-project` skill 在**完整克隆**基础上叠加脚手架（非全新 init）：

- [x] git 仓库（完整克隆自 github.com/kirozeng/MivoCanvas，保留全部 commit 历史）
- [x] 主分支 `main`
- [x] `.gitignore`（Vite 默认 + ECC 规则合并）
- [x] `CLAUDE.md`
- [x] `VERSIONING.md`（本文件）
- [x] 脚手架 commit：`chore: scaffold ECC project conventions on cloned MivoCanvas`
- [x] 注册到 `~/.claude/history/registry.json`
- [x] pre-commit hook 已装（`~/.claude/scripts/pre-commit-generic.sh`）
- **origin**：`https://github.com/kirozeng/MivoCanvas.git`（upstream，开发者有 WRITE 权限可直接 push）

## 2. 提交触发机制（手动）

**唯一触发方式**：用户喊触发词 → `commit-projects` skill 批量扫所有 `Project*/` 提交。

**触发词**：`提交代码`、`提交项目`、`提交所有项目`、`commit`、`git commit`

**不存在以下机制**（已明确删除）：
- ❌ Stop hook 自动提交
- ❌ EOD 自动提交
- ❌ SOD 自动提交
- ❌ 任何后台定时提交

## 3. .gitignore 必含项

| 类别 | 模式 |
|------|------|
| 敏感数据 | `.env*`、`*.key`、`*.pem`、`credentials/`、`*.token.json`、`.auth.json` |
| ECC 会话 | `history/checkpoints/`、`history/daily/`、`.claude/` |
| macOS | `.DS_Store`、`*.icloud`（兜底）、`*.swp` |
| IDE | `.idea/`、`.vscode/` |
| 语言特定（node） | `node_modules/`、`dist/`、`build/`、`coverage/` |

**新增敏感文件类型时必须同步**到 `.gitignore`。

## 4. Commit Message 规范

格式：`<type>: <一句话>`

类型：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`

示例：
- `feat: 添加用户认证模块`
- `fix: 修复登录后 token 失效问题`
- `chore: 手动提交 2026-07-01 14:30`（commit-projects skill 默认）

## 5. 分支策略

- **main**：主分支，唯一长期分支（跟踪 upstream kirozeng/MivoCanvas main）
- 功能开发：`feat/<descriptor>` 短分支，完成后合并 main
- 紧急修复：`hotfix/<descriptor>`

## 6. Push 策略

- **本项目 origin = upstream（kirozeng/MivoCanvas），开发者账号 PraiseZhu 有 WRITE 权限，可直接 `git push origin main`。**
- push 前确认本地 main 干净 + pre-commit hook 通过。
- 若日后要保留个人实验分支不污染 upstream：建 `feat/<name>` 分支 push，或 fork 到 PraiseZhu 个人仓再 PR 回 upstream。
- 注：源仓无 license，再发布/公开 fork 需注意 license 合规；私有协作仓内自用风险较低。

## 7. 不可提交红线

以下内容入 git **必须立即 reset + 强制清除**：

- 任何 API key（OpenAI / Anthropic / GitHub PAT / AWS / 通用 api_key 模式）
- OAuth token / JWT
- 数据库密码
- 用户个人信息（PII）
- 大文件（>50MB），改用 Git LFS 或外置存储

## 8. 存储位置说明

本项目位于**本地磁盘**（`/Users/praise/AI-Agent/Claude/`，APFS 卷 `/dev/disk3s5`，非 iCloud Drive）。

- 无 iCloud 多设备同步，不存在 `.git/index.lock` 跨设备冲突风险
- 不需要 `.nosync` 后缀规避同步
- 大文件直接用 Git LFS 或外置目录
- pre-commit hook 的 `.icloud` 占位检查为兜底（工作区已非 iCloud，正常不触发；若有文件从 iCloud 拷入带占位仍能拦）

## 9. safe-commit 三道闸

`commit-projects` skill 调用 `~/.claude/scripts/lib/git-safe-commit.sh`，自动：

1. **文件名排除**：跳过 `.env*` / `*.key` / `credentials*` / `*secret*` / `*.token.json` / `.auth.json`
2. **内容 secret 扫描**：grep 高熵模式（OpenAI/GitHub/AWS/JWT/RSA private key 等）— 命中即整个项目跳过
3. **文件量阈值**：>500 文件 → 跳过 + 警告"请人工审 .gitignore"

此外 pre-commit hook（`.git/hooks/pre-commit`）在 commit 时拦截：>1MB 新文件、.icloud 占位、敏感文件名、内容 secret 模式。

## 10. 紧急回滚指引

| 场景 | 操作 |
|------|------|
| 上一次 commit 不该提（含敏感信息） | `git reset --soft HEAD~1` 撤回到 staging |
| 已 push 出去含敏感信息 | **立即作废泄露 token**，再 `git filter-repo` 清史 |
| 误删 commit | `git reflog` 找回 hash → `git reset --hard <hash>` |
| 主分支被破坏 | macOS Time Machine 回滚整个 `.git` 目录（若开启）或 `git reflog` 找回 |

## 11. EOD 行为说明

EOD 流程（`workday-eod` skill）**不会自动 commit 本项目**。EOD 仅做：
- 工作区清理（清缓存、调试文件）
- Checkpoint 生成（写到 `~/.claude/history/checkpoints/`）
- 日报、审计、知识收割

如果 EOD 时本项目还有 dirty，是预期行为 — 等你手动喊"提交代码"。
