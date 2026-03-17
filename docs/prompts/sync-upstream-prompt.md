# 上游同步初始提示词

> 在 Cursor 中使用 Plan Mode 时，粘贴以下提示词开始同步流程

---

## 提示词

```
我需要将上游仓库 wechatsync/Wechatsync 的新功能合并到我的 fork 项目中。

## 当前状态

- 我的仓库: https://github.com/mmwyl/Wechatsync.git (origin)
- 上游仓库: https://github.com/wechatsync/Wechatsync.git (upstream)
- 主分支: v2
- GitHub 显示: This branch is 41 commits ahead of and 66 commits behind wechatsync/Wechatsync:v2

## 我的自定义功能（需要保留）

1. 使用 storage 中转解决大文章同步时消息超过 64MiB 限制
2. 添加搜狐平台适配器
3. 修复微信同步后代码块样式错乱问题
4. 改进微信和知乎的代码块提取和格式化
5. 修复经编辑器同步空白文章及懒加载图片路径被忽略问题
6. 修复 logger 全局配置 level 可能为 undefined 的问题
7. 添加文档导入功能，支持 Word 和 Markdown 文件
8. 增加东方财富适配器

## 要求

1. 在新分支上进行合并操作，不要直接修改 v2 分支
2. 合并后保留我的所有自定义功能
3. 合并后确保项目能正常构建和运行
4. 提供详细的冲突解决指导

请帮我制定详细的合并计划。
```

---

## 使用方法

1. 在 Cursor 中按 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Plan Mode" 并选择进入计划模式
3. 粘贴上面的提示词
4. AI 会帮你制定详细的合并计划

---

## 备选提示词（如果网络不好）

如果 fetch upstream 超时，可以先使用 GitHub API 查看差异：

```
我需要将上游仓库 wechatsync/Wechatsync 的新功能合并到我的 fork 项目中。

由于网络问题，git fetch upstream 超时。请帮我：

1. 使用 GitHub API 查看上游仓库的最新提交
2. 分析哪些提交是我需要合并的
3. 制定详细的合并计划

上游仓库: https://github.com/wechatsync/Wechatsync
我的仓库: https://github.com/mmwyl/Wechatsync
主分支: v2
```
