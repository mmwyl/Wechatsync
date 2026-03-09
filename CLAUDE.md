# CLAUDE.md - Wechatsync 项目开发指南

## 项目概述

微信公众号同步助手，支持一键将文章同步到多个内容平台。

### 项目结构

```
wechatsync/
├── packages/
│   ├── core/           # 核心包 - 适配器基类和平台适配器
│   ├── extension/      # Chrome 扩展
│   ├── mcp-server/     # MCP 服务器
│   └── cli/           # CLI 工具
├── docs/              # 文档
└── .claude/           # Claude Code 配置
    └── commands/       # 自定义命令
```

### 关键包

| 包 | 说明 | 关键文件 |
|---|---|---|
| `@wechatsync/core` | 适配器基类和平台适配器 | `packages/core/src/adapters/` |
| `@wechatsync/extension` | Chrome 扩展 | `packages/extension/src/` |
| `@wechatsync/mcp-server` | MCP 服务 | `packages/mcp-server/` |
| `@wechatsync/cli` | 命令行工具 | `packages/cli/` |

## 常用命令

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建全部
pnpm build

# 构建单个包
pnpm build:core
pnpm build:extension
pnpm build:mcp
pnpm build:cli

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint

# 测试
pnpm test
```

## 开发环境

- Node.js >= 18
- Chrome >= 110 (MV3 支持)
- TypeScript >= 5.0
- pnpm

## 架构要点

### 1. Service Worker 限制

适配器运行在 **Chrome Extension Service Worker** 中，这是一个受限环境：

**不可用** - 必须用正则替代：
- `DOMParser` → 正则表达式
- `document` → `runtime.dom` 或正则
- `localStorage` → `runtime.storage`

**可用**：
- `fetch` (带 cookies)
- `RegExp`
- `JSON`

### 2. 适配器继承关系

```
PlatformAdapter (interface)
        ↓
  CodeAdapter (abstract class)
        ↓
  XxxAdapter (concrete class)
```

### 3. 命名规范

- **平台 ID**: 小写英文，如 `douyin`, `juejin`
- **平台名称**: 中文，如 `抖音`, `掘金`
- **类名**: `XxxAdapter`，如 `JuejinAdapter`
- **文件名**: 小写连字符，如 `juejin.ts`

### 4. 图片上传失败处理

**重要 Gotcha**: 图片上传失败时，必须保留原始 URL 而不是删除图片：

```typescript
// ✅ 正确：保留原始 URL
try {
  uploadResult = await uploadFn(src)
  // 替换为新 URL
  result = result.replace(full, newUrl)
} catch (error) {
  // 保留原始 URL，不替换
  logger.warn(`Keeping original image URL: ${src}`)
}

// ❌ 错误：失败时删除图片
// result = result.replace(full, '') // 不应该这样做
```

### 5. HTML 解析

Service Worker 中禁止使用 DOMParser，必须用正则：

```typescript
// ❌ 错误
const parser = new DOMParser()
const doc = parser.parseFromString(html, 'text/html')

// ✅ 正确
const match = html.match(/data-user-id="(\d+)"/)
const userId = match?.[1]
```

### 6. Header 规则使用

```typescript
// 添加规则前必须检查
if (!this.runtime.headerRules) return

// 使用 withHeaderRules 自动管理
await this.withHeaderRules(rules, async () => {
  // 发布逻辑
})
```

### 7. delay 函数

图片上传等操作需要添加延迟避免请求过快：

```typescript
// 在 try 块内执行延迟
try {
  uploadResult = await uploadFn(src)
  // 替换 URL
  // 成功后延迟
  await this.delay(300)
} catch (error) {
  // 失败时不延迟
}
```

## 代码风格

### 1. 常量抽取

重复使用的字符串应抽取为常量：

```typescript
// ✅ 正确
export const FILE_ACCEPT = '.docx,.md,.markdown'
<input accept={FILE_ACCEPT} />

// ❌ 错误
<input accept=".docx,.md,.markdown" />
```

### 2. 接口设计

避免冗余字段：

```typescript
// ✅ 正确
interface ParsedDocument {
  title: string
  content: string  // HTML
  markdown: string // 原始 markdown（docx 为空）
}

// ❌ 错误
interface ParsedDocument {
  content: string
  html: string  // 与 content 冗余
}
```

### 3. 条件判断

互斥条件应独立判断：

```typescript
// ✅ 正确
if (config.convertSectionToDiv) {
  convertSections(container, 'div')
}
if (config.convertSectionToP) {
  convertSections(container, 'p')
}

// ❌ 错误
if (config.convertSectionToDiv) {
  convertSections(container, 'div')
} else if (config.convertSectionToP) { // 不应互斥
  convertSections(container, 'p')
}
```

### 4. 预编译正则

循环中使用正则应预编译：

```typescript
// ✅ 正确
const STYLE_REGEX = {
  color: /color:\s*([^;]+)/,
}
elements.forEach(el => {
  const match = el.getAttribute('style')?.match(STYLE_REGEX.color)
})

// ❌ 错误
elements.forEach(el => {
  const match = el.getAttribute('style')?.match(/color:\s*([^;]+)/)
})
```

## 调试技巧

### 扩展调试

1. 打开 `chrome://extensions`
2. 点击扩展的 "Service Worker" 链接
3. 查看 Console 和 Network 面板

### 本地测试

1. `pnpm build` 构建扩展
2. Chrome 加载 `packages/extension/dist` 目录
3. 打开目标平台并登录
4. 测试同步功能

## 提交规范

使用 Conventional Commits：

```bash
feat: 添加新功能
fix: 修复 bug
refactor: 重构
docs: 文档更新
chore: 构建/工具链变化
```

示例：
```
feat: 添加文档导入功能，支持 Word 和 Markdown 文件

- 新增 document-importer 模块
- HomeNew 和 EditorApp 添加导入按钮
- 优化图片上传失败处理
```
