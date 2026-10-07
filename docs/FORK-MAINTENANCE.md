# Fork 维护流程（Debian 模式）

本仓库是 `NarraFork/NarraFork` 的下游发行版，由 `wcpe` 维护。所有改动以「补丁集」形式叠加在上游之上，上游代码本身永远不修改。

模式取自 Debian：上游源码独立存放，本发行版的全部改动构成一个**有序补丁队列**，可逐个重放、逐个追溯、逐个决定去向。

## 角色与远程仓库

| 远程 | 地址 | 用途 |
|------|------|------|
| `upstream` | `https://github.com/NarraFork/NarraFork` | 上游，只读。**不要在它的历史上工作**。 |
| `origin` | `https://github.com/wcpe/NarraFork` | 本发行版的发布仓库。 |

```bash
git remote -v
# origin    https://github.com/wcpe/NarraFork
# upstream  https://github.com/NarraFork/NarraFork
```

## 分支规范

| 分支 | 含义 | 生命周期 |
|------|------|----------|
| `wcpe/main` | 发行版主线 = 上游 + 本发行版的全部补丁 | 长期存在 |
| `wcpe/<topic>` | 单个补丁的开发分支，完成后合入 `wcpe/main` | 临时，用完即删 |
| `backup/<desc>-<date>` | 危险操作（rebase 等）前的快照 | 确认无误后删除 |

命名沿用 Debian 的 `<vendor>/<line>` 约定：`vendor` 是维护者标识（`wcpe`），`line` 是产品线（`main`）。**不要用版本号命名分支**——上游从 0.8 升到 0.9 时分支名不应变化。

本地不保留 `main` 分支：上游的状态由 `upstream/main` 远程引用表示，避免与发行版主线混淆。

**补丁是提交，不是分支。** 补丁队列 = `wcpe/main` 上的线性提交序列（下图为 v0.8.3-wcpe.1 发布时的状态，实际以 `git log --oneline upstream/main..wcpe/main` 为准）：

```
upstream/main (4e04d2f2e)
      │
      ├─  1  feat(orchestration): 编排运行级观测与开销归集
      ├─  2  feat(orchestration): 编排界面、档位配置与工具面收窄
      ├─  3  feat(orchestration): 编排入口、消息列表与会话适配
      ├─  4  fix(db): 修正迁移基线与过时迁移测试
      ├─  5  build: 补齐跨平台构建脚本与依赖锁定
      ├─  6  fix(narrator): 补齐列表归档、分叉、复制与文件树隐藏文件行为
      ├─  7  fix(inbox): 统一唤醒谓词并补齐状态栏与测试引用
      ├─  8  feat(narrator): 支持父叙述者之间互相通信
      ├─  9  fix(narrator): 持久化屏障失败时补出具体原因
      ├─ 10  ci: 新增多平台构建发布工作流
      ├─ 11  docs: 新增 fork 维护流程文档
      └─ 12  release: v0.8.3-wcpe.1
                    ↑ wcpe/main
```

补丁之间存在顺序依赖（例如补丁 3 的编排入口依赖补丁 1 建立的数据模型），因此队列必须是线性的。分支用于开发过程，不用于存放补丁。

## 版本号规范

```
<上游版本>-wcpe.<修订号>

0.8.3-wcpe.1    首次基于上游 0.8.3
0.8.3-wcpe.2    只改了本发行版的补丁，上游未动
0.8.4-wcpe.1    上游升到 0.8.4，修订号归 1
```

与 Debian 的 `<upstream>-<revision>`（如 `1.2.3-2ubuntu1`）同构：Debian 在**最后一个** `-` 处切分，`1.2.3` 是上游版本、`2ubuntu1` 是发行版修订。

**分隔符必须是连字符，不能写成点号。** `0.8.3.wcpe.1` 这种四点式会失去切分点——既无法像 Debian 那样机械地拆出上游版本，也不是合法 semver，发布脚本会直接拒绝。改版本号时最容易犯这个错，因为两种写法看起来只差一个字符。

版本号受两道校验约束，二者都要求 `x.y.z` 或 `x.y.z-prerelease`：

| 位置 | 约束 |
|------|------|
| `scripts/release.ts` | `VERSION_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$/` |
| `shared/release-version.ts` | `isValidReleaseVersion()`：标准 semver，外加「数字段不得有前导零」 |

而 `scripts/build-cross-platform.ts` **不做任何校验**，只把 `package.json` 的 `version` 原样拼进产物名。所以格式错误不会在构建时暴露，只会在发布时失败——**改完版本号先跑一次 `--dry-run` 预检**（见「发布」一节）。

修订号只在**本发行版补丁集变化**时递增，与上游版本解耦，上游升版时归 1。

版本号写在 `package.json` 的 `version` 字段。版本号**常驻仓库**（对应 Debian 的 `debian/changelog`），不是构建时临时修改。

## 版本通道

NarraFork 只认两档通道，判定写在 `releaseChannel()`（`scripts/lib/github-release.ts`）里：

| 通道 | 判定 | GitHub 上的表现 | Debian 对应 |
|------|------|----------------|-------------|
| `stable` | 版本严格等于 `x.y.0` | 正式 Release，标记 latest | stable |
| `beta` | 其他一切版本 | prerelease，不标记 latest | unstable / experimental |

**本发行版的所有版本都落在 beta。** `<上游版本>-wcpe.<修订号>` 带 prerelease 后缀，永远不可能匹配 `x.y.0`。

这不是缺陷，而是与定位一致：发行版跟随上游持续带修订，处在 Debian 的 unstable/testing 区间，而不是冻结后的 stable。beta 通道对客户端是**可用**的——升级检测在 beta 通道下同时考虑正式 Release 与 prerelease 并按语义版本排序，用户可以在设置里选 beta 通道收到本发行版。

### 三种发布形态

对应 Debian 的常规上传、experimental 预览与 stable 晋升：

| 形态 | 做法 | 版本号变化 | 制品变化 |
|------|------|-----------|---------|
| **常规发布**（开发/预览） | 递增修订号 → 构建 → 上传 | `0.8.3-wcpe.1` → `0.8.3-wcpe.2` | 新二进制 |
| **正式发布**（stable 晋升） | `gh release edit` 改发布状态 | **不变** | **不变** |
| **本地验证** | 只发到测试更新服务器 | 同常规发布 | 新二进制 |

正式发布是**原地晋升**，不重新构建、不改 tag：

```bash
gh release edit v0.8.3-wcpe.1 --prerelease=false --latest
```

这与 Debian 的 `dch --release` 同构——Debian 把 changelog 里的 `UNRELEASED` 改成发行版名，同样不动 `upstream_version`，也不重新构建。

⚠ **晋升不是幂等的**：`docs/RELEASE.md` 明确说明，晋升后不能再按原 beta 身份重试发布。要补资产只能发新版本。

只想自测的版本走独立的测试更新服务器，不影响生产，具体命令见 `docs/RELEASE.md` 的「发布目标服务器」一节。

## 补丁生命周期

每个补丁都有明确的去向状态，用 git trailer 记录在提交信息末尾。

### 状态定义

沿用 Debian 的 `Forwarded` 字段语义：

| 状态 | trailer 写法 | 含义 |
|------|-------------|------|
| 未决定 | （无 trailer） | 尚未评估是否推上游 |
| 已在本地测试 | `Forwarded: pending-testing` | 抢先功能，先自用验证，稳定后再提 |
| 已提上游 | `Forwarded: <PR URL>` | 已提交 PR，等待反馈 |
| 上游已接受 | `Forwarded: yes` | 上游已合并（下次 rebase 时自动移除） |
| 明确不推 | `Forwarded: no (<原因>)` | 发行版特有，必须写明原因 |
| 上游不需要 | `Forwarded: not-needed` | 上游架构不涉及，如构建配置、发布脚本 |

### 状态机

```
创建补丁
   │
   ├─ 通用能力 ──────────→ pending-testing ──→ 提 PR ──→ <PR URL>
   │                                                      │
   │                                          ┌───────────┴───────────┐
   │                                          ↓                       ↓
   │                                     上游接受                上游拒绝/无回应
   │                                          ↓                       ↓
   │                                  Forwarded: yes          Forwarded: no
   │                                          │                  (永久维护负担)
   │                                          ↓
   │                                  下次 rebase 自动移除
   │
   └─ 发行版特有 ────────→ Forwarded: no / not-needed
                              (永久维护负担)
```

### 标注方法

提交信息末尾加 trailer（与正文空一行）：

```
feat(narrator): 支持父叙述者之间互相通信

父叙述者 A 需要把任务派给兄弟 B，此前只能经由主代理绕行，
多一层转发就多一层信息损失...

Forwarded: https://github.com/NarraFork/NarraFork/pull/123
```

不推的补丁必须写明原因，便于日后复查：

```
fix(rebase): 补齐变基收尾的类型与测试引用

Forwarded: no (wcpe 分支重放时的收尾修补，上游无对应上下文)
```

### 筛选命令

```bash
# 已提上游、等待反馈
git log upstream/main..wcpe/main --grep="^Forwarded: http"

# 明确不推的补丁 —— 这个列表的长度就是你的永久维护负担
git log upstream/main..wcpe/main --grep="^Forwarded: no"

# 抢先功能，还在自用验证
git log upstream/main..wcpe/main --grep="^Forwarded: pending-testing"

# 还没决定去向的（技术债，应尽快清零）
git log upstream/main..wcpe/main --grep -v "^Forwarded:"
```

最后一条输出应定期清零：每个补丁要么提上游，要么明确标为不推。

### 抢先功能的处理

先在发行版里落地、自用验证、成熟后再推上游，这是 Debian 的标准做法（大量补丁先在发行版跑几个版本才推上游）。

流程：

```
① 在 wcpe/main 开发            trailer: Forwarded: pending-testing
        ↓
② 自用数周，迭代修 bug           （补丁可能分裂为多个提交）
        ↓
③ 稳定后提 PR                   trailer 改为 Forwarded: <PR URL>
        ↓
   ┌────┴────┐
   ↓         ↓
上游接受    上游拒绝/无回应
   ↓         ↓
自动移除    Forwarded: no
```

抢先的**战略价值**：你带着实战验证和修复过的边界情况提 PR，接受概率远高于一上来就提。

**纪律**：一旦提了 PR，就不要再大改那个补丁——上游 review 的代码和你队列里的必须一致。要改就等 review 意见回来一起改。

### 上游接受后移除补丁

不需要手动删补丁。rebase 时 git 会自动发现「内容已在上游」的补丁变成空提交：

```bash
git fetch upstream
git rebase upstream/main --empty=drop
```

`--empty=drop` 需要 git ≥ 2.26。旧版本会停下提示 `The previous cherry-pick is now empty`，此时 `git rebase --skip` 跳过即可。

若上游是**部分接受**（改过你的补丁才合并），补丁不会变空，会正常重放并产生冲突——在这里手工把已上游化的部分剔除。

## 日常流程

### 1. 同步上游（对应 Debian 的 `quilt push -a`）

```bash
git fetch upstream
git checkout wcpe/main
git rebase upstream/main --empty=drop
```

冲突**逐个提交解决**，不要中途 squash。冲突解决不掉的提交说明它与上游产生了语义冲突，应回到该提交重新设计。

rebase 完成后必须验证：

```bash
bunx tsgo --noEmit                    # 类型检查
bun test --isolate <相关测试路径>      # 相关测试
```

若上游新增了路由，还需重新生成路由树：

```bash
bun run dev:frontend     # 启动一次即可生成，随后可停止
```

`frontend/routeTree.gen.ts` 不纳入版本控制（见 `.gitignore`），由 vite 插件在开发服务器启动时产出。上游新增路由文件但未重新生成时，`tsgo` 会报 `Argument of type '"/xxx"' is not assignable to parameter of type 'keyof FileRoutesByPath'`。

**同步频率**：建议每周一次。攒得越久，一次要处理的冲突越多。

### 2. 开发新补丁

```bash
git checkout wcpe/main          # 小改动直接在主线提交
# 或
git checkout -b wcpe/<topic>    # 较大的功能用临时分支
```

每个补丁**独立成一个提交**，提交信息说明「为什么改」，并按上节标注 `Forwarded`。

**粒度规则**：一个补丁做一件可描述的事。

- **应当合并**：同一功能的迭代与修复。若放任它们各自成篇，队列里很快会出现「补丁修补补丁」，既难追溯也难向上游说明。
- **不应当合并**：不同功能。压在一起会让 rebase 冲突只能在超大提交内解决（容易遗漏），也失去向上游单独提其中一个部分的能力。

合并的时机是**发布前的整理窗口**（见下节）。日常修复先以新提交存在，发布时再统一收敛。

### 3. 修复如何入队

修复的入队方式取决于**补丁是否已推送**：

| 情况 | 做法 |
|------|------|
| 补丁仍在本地（未 push） | squash 进原补丁，队列保持干净 |
| 已 push 但仅自己使用 | 同上，改完 `git push --force-with-lease` |
| 已 push 且有他人使用 | 追加新补丁——改写历史会让对方必须 force pull |
| 已对外发布（打过 tag / 发过二进制） | **必须追加新补丁** |

Debian 的实际节奏是：**日常修复加新补丁，发布前的整理窗口统一收敛**。因此队列规模会在两次发布之间先增长、发布时再回落，这是正常的呼吸，不是失控。

### 4. 发布

发布有两条路径，**产出同一套资产集合**（`docs/RELEASE.md` 有完整约定）：

| 路径 | 做法 | 适用 |
|------|------|------|
| **CI 构建发布**（推荐） | 推送 tag，工作流接管构建与上传 | 正常发版 |
| **本地构建发布** | `bun scripts/release.ts <版本>` | 预检验证、测试服务器、CI 不可用时 |

两条路径都要求**先完成发布提交与 tag**：发布脚本要求 `v<版本>` tag 先于发布存在，且明确不会自动创建或推送 tag。

#### 步骤 1：发布准备

```bash
# ── 0. 确认状态干净 ──
git checkout wcpe/main
git status                              # 必须无未提交改动

# ── 1. 发布前同步上游（避免带着过时基线发版）──
git fetch upstream
git rebase upstream/main --empty=drop
bunx tsgo --noEmit                      # 确认没被上游改动破坏

# ── 2. 递增版本号 ──
#    编辑 package.json 的 version。注意分隔符是连字符，不是点号：
#      0.8.3-wcpe.1 → 0.8.3-wcpe.2   （仅自己的补丁变化）
#      0.8.3-wcpe.2 → 0.8.4-wcpe.1   （上游升到 0.8.4，修订号归 1）

# ── 3. 写 changelog ──
#    新建 changelogs/v0.8.3-wcpe.2.json：
#    {
#      "version": "0.8.3-wcpe.2",
#      "date": "2026-10-08",
#      "en": "## Changes\n\n- ...",
#      "zh-CN": "## 变更\n\n- ..."
#    }

# ── 4. 提交并打 tag ──
git add package.json changelogs/v0.8.3-wcpe.2.json
git commit -m "release: v0.8.3-wcpe.2"
git tag v0.8.3-wcpe.2
```

changelog **不是可选项**：`scripts/release.ts` 读 `changelogs/v<版本>.json` 作为 GitHub Release 正文（`githubReleaseBody()` 取 `en` 与 `zh-CN` 拼成双语 body），文件缺失时正文为空；构建脚本也会把 `changelogs/*.json` 嵌入二进制供 `/changelog` 页面读取。

#### 步骤 2：构建并发布

**路径 A —— CI（推荐）**

```bash
git push origin wcpe/main --follow-tags
```

推送 `v*` tag 触发 `.github/workflows/build-release.yml`，它构建全部 8 个平台并调发布脚本上传。细节见下节。

**路径 B —— 本地**

```bash
# 一次构建全部平台（不要分平台构建，理由见下方警告）
bun run build:cross

# 预检：构建并校验本地产物，不联网、不提交、不打 tag
bun scripts/release.ts 0.8.3-wcpe.2 --target=github --dry-run

# 推送 tag 后正式上传（--upload-only 复用已有 dist/）
git push origin v0.8.3-wcpe.2
bun scripts/release.ts 0.8.3-wcpe.2 --target=github --upload-only
```

⚠ **务必一次构建全部平台**。`scripts/build-cross-platform.ts` 每次运行都会重写 `SHA256SUMS` 与 `checksums.txt`，只保留本次构建的平台。若分两次跑 `--platform=linux-x64` 与 `--platform=windows-x64`，第二遍会覆盖第一遍的校验和文件，只剩 Windows 条目，发布时因平台缺失而失败。只要一次跑完全平台，就不存在这个问题——也不再需要任何手工合并校验和的步骤。

产物命名会带版本号（如 `narrafork-0.8.3-wcpe.2-windows-x64.exe`），与上游同名版本天然区分。

**tag 的作用**：`v0.8.3-wcpe.2` 指向 release 提交，二进制由该提交构建，产物与源码可追溯（Debian 用 `.dsc` 文件承担同一职责）。发布脚本会核对 tag 解析出的提交与本地一致。

**发布提交也进入补丁队列**，下次 rebase 时会被一并重放。但它只改 `package.json` 与 `changelogs/`，几乎不会与上游冲突。

## 构建发布 CI

`.github/workflows/build-release.yml` 负责构建全部平台并发布 GitHub Release。

**触发方式**：推送 `v*` tag（正常路径），或 `workflow_dispatch` 手动指定版本号补发。

**为什么是单 runner 而不是矩阵**：Bun 支持从 Linux 交叉编译 macOS/Windows（见 `docs/BUILD.md`），单次 `bun run build:cross` 即可产出全部 8 个平台。这不只是图省事——`scripts/build-cross-platform.ts` 每次运行都会重写 `SHA256SUMS` 与 `checksums.txt`，只保留本次构建的平台；拆成矩阵会让每个 job 各自产出一份只含单平台的聚合校验文件，发布时必然失败。

**8 个平台**：

| 平台后缀 | 说明 |
|---------|------|
| `macos-arm64` / `macos-x64` | macOS Apple Silicon / Intel |
| `linux-x64` / `linux-x64-baseline` / `linux-arm64` | Linux |
| `windows-x64.exe` / `windows-x64-baseline.exe` / `windows-arm64.exe` | Windows（带 `.exe`） |

**工作流步骤**：

1. 检出源码（`fetch-depth: 0`——发布脚本需要读到已存在的 tag 对象）
2. 解析版本号（tag 去掉 `v` 前缀，或 dispatch 输入）
3. **三重一致性校验**：版本号格式合法 → `package.json` 与之相同 → `v<版本>` tag 存在且指向当前检出提交
4. `bun run build:cross` 构建全部平台
5. 校验 8 个平台二进制 + `.metadata.json` + 两份聚合校验文件齐备，且聚合文件确实覆盖全部平台
6. `sha256sum -c` 复核校验和
7. 调 `bun scripts/release.ts <版本> --target=github --upload-only` 上传

第 7 步复用发布脚本而非直接调 `gh release`，是为了继承它的完整语义：**create draft → 上传 → 校验完整资产集合 → 最后公开**，失败时保留 draft，重试复用一致资产且绝不 clobber，已公开版本不可替换或补传。工作流用 `--github-repository="${GITHUB_REPOSITORY}"` 取当前仓库，因此在 `wcpe/NarraFork` 与上游同样可用。

第 3 步的校验是有意而为之：发布脚本要求 tag 先于发布存在且不会自动创建它，把这三项前置到构建之前，可以让明显的配置错误在构建开始前就失败，而不是在耗时的全平台构建之后。

**CI 与本地发布的产出完全一致**（`docs/RELEASE.md` 有完整资产约定）。启用 CI 后本地不必再跑构建上传，但本地构建仍可用于验证；`bun scripts/release.ts <版本> --dry-run` 可在推送前确认一切就绪。

## 补丁纪律

以下规则来自 Debian，是模式能长期运转的前提：

1. **能推上游的就推上游**。通用能力（不依赖本发行版特有假设的功能）应向上游提 PR。上游接受后补丁自动从队列移除，未来的冲突自然减少。

2. **补丁之间保持正交**。相互独立的补丁不应互相依赖，这样它们才能被单独 cherry-pick——向上游提 PR 时往往只需要其中一个。

3. **已发布的补丁不回改**。一旦 `wcpe/main` 被推送并对外分发，不要再 rebase 它改写历史（`--empty=drop` 导致的补丁移除除外，那是上游前进的自然结果）。需要修正时**追加新补丁**。确有必要改写时，只能 `git push --force-with-lease` 并明确告知使用者。

4. **不推上游的补丁要写明原因**。`Forwarded: no` 是合法状态，但必须附原因，便于日后复查——上游方向变化后，原本不能推的补丁可能变得可推。

5. **定期复查 `Forwarded: no` 列表**。每项都是永久维护负担，数量应尽量少。若某补丁的冲突越来越频繁，考虑缩小其范围，或放弃该功能。

## 与 Debian 的对应关系

| Debian 概念 | 本项目对应物 |
|-------------|--------------|
| `foo_1.2.3.orig.tar.gz`（上游源码，字不改） | `upstream` 远程仓库 |
| `debian/patches/*.patch` | `wcpe/main` 上的提交 |
| `debian/patches/series` | 提交顺序（`git log upstream/main..wcpe/main` 即为 series） |
| `debian/changelog` | `package.json` 的 `version` + `changelogs/` |
| `1.2.3-2ubuntu1`（最后一个 `-` 切分上游与修订） | `0.8.3-wcpe.1` |
| `1.2.3-1` → `1.2.3-2`（仅发行版修订变化） | `0.8.3-wcpe.1` → `0.8.3-wcpe.2` |
| `quilt push -a` | `git rebase upstream/main --empty=drop` |
| `Forwarded: <url>` | 提交信息里的 `Forwarded:` trailer |
| `Last-Update` | 提交日期 |
| `dput` 上传 | `git push origin wcpe/main --follow-tags` |
| `.dsc` 校验文件 | 构建产物的 `SHA256SUMS` + `metadata.json` |
| `debian/` 目录隔离 | `wcpe/main` 分支隔离 |
| unstable / experimental（开发与预览） | beta 通道（GitHub prerelease，不标 latest） |
| stable（冻结后发布） | stable 通道（版本严格等于 `x.y.0`） |
| `dch --release`（改 Distribution 字段，版本号与制品都不动） | `gh release edit --prerelease=false --latest` |
| `+debNuX`（stable 增量更新） | `.from-<版本>.zstd-patch` 直达增量包 |
| `+really`（回滚到旧上游版本，不删历史） | 发布新版本；已公开版本不可替换或补传 |
| buildd 构建集群 | `.github/workflows/build-release.yml` |

最后一行的对应值得展开：Debian 把构建派给 buildd 集群，开发者本地只提交源码；本项目的 CI 承担同样的角色——本地只推 tag，全平台二进制由 CI 构建上传。区别是 Debian 的 buildd 是常驻基础设施，而这里是一个按 tag 触发的一次性 job。

## 故障处理

**上游历史被重写（force push）**：`git fetch upstream` 会报 `forced update`。此时 `git rebase upstream/main` 仍然可用；若冲突异常多，用 `git log --oneline upstream/main | head` 确认上游是否整体重排了历史，必要时从上游的某个稳定 tag 重新起分支。

**rebase 中途放弃**：`git rebase --abort` 回到 rebase 前状态。若已经开始推送，用备份分支恢复：`git checkout wcpe/main && git reset --hard backup/<...>`。

**补丁集与上游完全无共同祖先**：说明拿到了错误的仓库地址，或对方重写过全部历史。检查 `git merge-base upstream/main wcpe/main` 是否返回提交；返回空表示两个历史互不相干，此时不能用 rebase，只能用 `git rebase --onto upstream/main <旧基点> wcpe/main`（需显式指定旧基点）或逐个 cherry-pick 重放。

**冲突解决不掉的补丁**：不要用 `--skip` 强行跳过——那会让补丁静默消失。应 `git rebase --abort` 后单独研究该补丁：它可能与上游的改动语义冲突，需要重新设计或拆分。
