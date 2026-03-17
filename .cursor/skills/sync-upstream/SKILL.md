---
name: sync-upstream
description: 将上游仓库 wechatsync/Wechatsync 的新功能合并到当前 fork 项目中。当用户提到"同步上游"、"合并上游更新"、"更新 fork"、"upstream sync"时使用此技能。
---

# 上游同步技能

将 `wechatsync/Wechatsync` 的新功能安全合并到你的 fork 项目中。

## 项目信息

- **上游仓库**: `upstream` → `https://github.com/wechatsync/Wechatsync.git`
- **你的仓库**: `origin` → `https://github.com/mmwyl/Wechatsync.git`
- **主分支**: `v2`

## 同步流程

### 步骤 1: 检查环境

```bash
# 查看远程仓库
git remote -v

# 如果没有 upstream，添加它
git remote add upstream https://github.com/wechatsync/Wechatsync.git
```

### 步骤 2: 获取上游更新

```bash
# 获取上游最新代码
git fetch upstream

# 查看差异
git log HEAD..upstream/v2 --oneline
```

### 步骤 3: 创建同步分支

```bash
# 确保在 v2 分支
git checkout v2

# 创建备份分支（安全措施）
git branch backup-v2-$(date +%Y%m%d)

# 创建同步分支
git checkout -b sync-upstream-$(date +%Y%m%d)
```

### 步骤 4: 合并上游

```bash
# 合并上游 v2 分支
git merge upstream/v2

# 如果有冲突，解决后继续
git add .
git commit -m "merge: sync upstream v2 updates"
```

### 步骤 5: 验证合并

```bash
# 安装依赖
pnpm install

# 构建项目
pnpm build

# 类型检查
pnpm typecheck

# 测试
pnpm test
```

### 步骤 6: 完成合并

```bash
# 切回主分支
git checkout v2

# 合并同步分支
git merge sync-upstream-$(date +%Y%m%d)

# 推送到你的仓库
git push origin v2
```

## 冲突解决原则

1. **保留自定义功能** - 你的修改是核心价值
2. **谨慎接受上游更改** - 评估每个更改的必要性
3. **测试关键功能** - 合并后测试所有平台适配器

## 需要保留的自定义功能

| 功能 | 文件位置 |
|------|----------|
| 大文章 storage 中转 | `packages/extension/src/background/` |
| 搜狐适配器 | `packages/core/src/adapters/sohu.ts` |
| 东方财富适配器 | `packages/core/src/adapters/eastmoney.ts` |
| 文档导入功能 | `packages/extension/src/lib/document-importer.ts` |
| 代码块格式化修复 | `packages/core/src/adapters/weixin.ts` |

## 回滚方案

如果合并后出现问题：

```bash
# 回滚到备份分支
git checkout v2
git reset --hard backup-v2-$(date +%Y%m%d)

# 或使用 reflog
git reflog
git reset --hard HEAD@{n}
```

## 检查清单

合并完成后验证：

- [ ] `pnpm build` 成功
- [ ] `pnpm typecheck` 通过
- [ ] Chrome 扩展加载正常
- [ ] 测试 2-3 个平台同步功能
- [ ] 自定义功能正常工作
