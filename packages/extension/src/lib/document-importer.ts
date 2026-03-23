/**
 * 文档导入模块
 *
 * 支持导入 Word (.docx) 和 Markdown (.md) 文件
 * 提取内容并保留基本样式
 */

import mammoth from 'mammoth'
import { marked } from 'marked'

/**
 * 支持的文件类型
 */
export const SUPPORTED_EXTENSIONS = {
  DOCX: 'docx',
  MD: 'md',
  MARKDOWN: 'markdown',
} as const

/**
 * 文件输入接受的 MIME 类型
 */
export const FILE_ACCEPT = '.docx,.md,.markdown'

/**
 * 解析后的文档结构
 */
export interface ParsedDocument {
  title: string
  content: string  // HTML 格式
  markdown: string // Markdown 原始内容
  styles: Record<string, string>
}

/**
 * 解析 Word (.docx) 文件
 * @param file Word 文件
 * @returns 解析后的文档
 */
export async function parseDocx(file: File): Promise<ParsedDocument> {
  const arrayBuffer = await file.arrayBuffer()

  // 使用 mammoth 解析 Word 文档
  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      styleMap: [
        // 段落样式
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        // 粗体和斜体
        "b => strong",
        "i => em",
        // 表格
        "table => table",
        "tr => tr",
        "td => td",
        "th => td",
        // 列表
        "p[style-name='List Paragraph'] => li:p",
      ],
      includeDefaultStyleMap: true,
    }
  )

  // 提取文档中的样式信息
  const styles = extractDocxStyles(result.value)

  // 从文件名提取标题（去掉扩展名）
  const title = file.name.replace(/\.docx$/i, '')
    .replace(/\.md$/i, '')
    .replace(/\.markdown$/i, '')

  return {
    title,
    content: result.value,
    markdown: '', // docx 转换为 HTML，无原始 markdown
    styles,
  }
}

/**
 * 解析 Markdown 文件
 * @param file Markdown 文件
 * @returns 解析后的文档
 */
export async function parseMarkdown(file: File): Promise<ParsedDocument> {
  const content = await file.text()

  // 使用 marked 解析 Markdown
  const html = await marked(content)

  // 从 Markdown 内容中提取标题（第一个 # 标题）
  const title = extractMarkdownTitle(content) || file.name
    .replace(/\.docx$/i, '')
    .replace(/\.md$/i, '')
    .replace(/\.markdown$/i, '')

  return {
    title,
    content: html,
    markdown: content,
    styles: {},
  }
}

// 预编译正则表达式（避免每次匹配时重新编译）
const STYLE_REGEX = {
  color: /color:\s*([^;]+)/,
  background: /background(-color)?:\s*([^;]+)/,
  fontSize: /font-size:\s*([^;]+)/,
  fontFamily: /font-family:\s*([^;]+)/,
}

/**
 * 从 Word 文档提取样式
 */
function extractDocxStyles(html: string): Record<string, string> {
  const styles: Record<string, string> = {}

  // 创建临时 DOM 来解析样式
  const container = document.createElement('div')
  container.innerHTML = html

  // 提取常见的内联样式
  const elements = container.querySelectorAll('*')
  elements.forEach((el) => {
    const style = el.getAttribute('style')
    if (style) {
      // 提取文字颜色
      if (!styles['color']) {
        const colorMatch = style.match(STYLE_REGEX.color)
        if (colorMatch) {
          styles['color'] = colorMatch[1]
        }
      }

      // 提取背景色
      if (!styles['background-color']) {
        const bgMatch = style.match(STYLE_REGEX.background)
        if (bgMatch) {
          styles['background-color'] = bgMatch[2]
        }
      }

      // 提取字体大小
      if (!styles['font-size']) {
        const fontSizeMatch = style.match(STYLE_REGEX.fontSize)
        if (fontSizeMatch) {
          styles['font-size'] = fontSizeMatch[1]
        }
      }

      // 提取字体
      if (!styles['font-family']) {
        const fontFamilyMatch = style.match(STYLE_REGEX.fontFamily)
        if (fontFamilyMatch) {
          styles['font-family'] = fontFamilyMatch[1]
        }
      }
    }
  })

  return styles
}

/**
 * 从 Markdown 内容中提取标题
 */
function extractMarkdownTitle(content: string): string | null {
  const lines = content.split('\n')
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/)
    if (match) {
      return match[1].trim()
    }
  }
  return null
}

/**
 * 根据文件扩展名判断文件类型
 */
export function getFileType(file: File): 'docx' | 'md' | 'unknown' {
  const ext = file.name.toLowerCase().split('.').pop()
  if (ext === SUPPORTED_EXTENSIONS.DOCX) return 'docx'
  if (ext === SUPPORTED_EXTENSIONS.MD || ext === SUPPORTED_EXTENSIONS.MARKDOWN) return 'md'
  return 'unknown'
}

/**
 * 解析文档的入口函数
 * @param file 文件
 * @returns 解析后的文档
 */
export async function parseDocument(file: File): Promise<ParsedDocument> {
  const fileType = getFileType(file)

  switch (fileType) {
    case 'docx':
      return parseDocx(file)
    case 'md':
      return parseMarkdown(file)
    default:
      throw new Error(`不支持的文件类型: ${file.name}`)
  }
}
