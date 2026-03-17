# Git 上游同步规则

## 项目 Fork 信息

- **上游仓库**: `https://github.com/wechatsync/Wechatsync.git` (upstream)
- **你的仓库**: `https://github.com/mmwyl/Wechatsync.git` (origin)
- **主分支**: `v2`

## 当前状态

你的 `v2` 分支相对于上游有：
- **41 commits ahead** - 你的自定义功能
- **66 commits behind** - 上游的新功能

## 自定义功能清单（需要保留）

根据提交历史，你的自定义功能包括：

| 提交 | 功能描述 |
|------|----------|
| `e8bde24` | 使用 storage 中转解决大文章同步时消息超过 64MiB 限制 |
| `9925fdd` | 添加搜狐平台适配器 |
| `2de6ab3` | 修复微信同步后代码块样式错乱问题 |
| `054c03e` | 改进微信和知乎的代码块提取和格式化 |
| `88eed24` | 修复经编辑器同步空白文章及懒加载图片路径被忽略问题 |
| `925f439` | 修复 logger 全局配置 level 可能为 undefined 的问题 |
| `3c44e7c` | 添加文档导入功能，支持 Word 和 Markdown 文件 |
| `d8d044b` | 增加东方财富适配器 |
| 其他 | 更多平台适配器和 bug 修复 |

## 同步策略

### 推荐方案：创建同步分支

```bash
# 1. 确保上游仓库已添加
git remote add upstream https://github.com/wechatsync/Wechatsync.git

# 2. 获取上游最新代码
git fetch upstream

# 3. 从当前 v2 创建同步分支
git checkout -b sync-upstream-v2

# 4. 尝试合并上游 v2
git merge upstream/v2

# 5. 解决冲突后测试
pnpm install
pnpm build
pnpm test

# 6. 确认无误后合并回 v2
git checkout v2
git merge sync-upstream-v2

# 7. 推送到你的仓库
git push origin v2
```

### 备选方案：Rebase（更干净但风险更高）

```bash
# 1. 创建备份分支
git branch backup-v2

# 2. 创建同步分支
git checkout -b rebase-upstream v2

# 3. Rebase 到上游
git rebase upstream/v2

# 4. 解决冲突...

# 5. 强制推送（如果之前已推送过）
git push origin rebase-upstream --force-with-lease
```

## 冲突解决原则

1. **优先保留你的自定义功能** - 你的功能是核心价值
2. **谨慎接受上游更改** - 评估每个更改的必要性
3. **测试关键功能** - 合并后必须测试所有平台适配器
4. **保留提交历史** - 使用 `--no-ff` 或 merge commit

## 合并后检查清单

- [ ] `pnpm install` 成功
- [ ] `pnpm build` 成功
- [ ] `pnpm typecheck` 通过
- [ ] Chrome 扩展加载正常
- [ ] 测试至少 2-3 个平台同步功能
- [ ] 检查自定义功能是否正常工作

## 注意事项

1. **永远不要在 v2 分支直接操作** - 先创建同步分支
2. **合并前创建备份** - `git branch backup-v2`
3. **小步合并** - 如果冲突太多，考虑按功能模块分批合并
4. **记录冲突** - 记录每个冲突的解决方案，方便后续参考
