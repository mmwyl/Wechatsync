/**
 * 什么值得买适配器
 *
 * API 分析结果:
 * - 用户信息: 从页面 HTML 中提取
 * - 草稿初始化: https://post.smzdm.com/api/draft/{article_id} (POST)
 * - 图片上传: https://post.smzdm.com/api/images/upload/local (POST)
 * - 自动保存: https://post.smzdm.com/api/editor/article/submit (POST, submit_type=auto_save)
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import CryptoJS from 'crypto-js'
import md5Lib from 'js-md5'

const jsMd5 = md5Lib as unknown as (message: string) => string

// 草稿响应类型
interface SmzdmDraftResponse {
  error_code?: number
  error_msg?: string
  data?: {
    article_id?: string
    article_url?: string
  }
}

// 图片上传响应类型
interface SmzdmImageResponse {
  error_code?: number
  error_msg?: string
  data?: {
    url?: string
    original_url?: string
  }
}

interface SmzdmSubmitResponse {
  error_code?: number
  error_msg?: string
}

export class SmzdmAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'smzdm',
    name: '什么值得买',
    icon: 'https://www.smzdm.com/favicon.ico',
    homepage: 'https://www.smzdm.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /** 当前文章 ID（用于图片上传） */
  private currentArticleId: string | null = null
  /** 草稿初始化返回的表单状态（用于对齐编辑器提交字段） */
  private draftMeta: Record<string, unknown> = {}

  /** 什么值得买 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://post.smzdm.com/post/api/*',
      headers: {
        'Origin': 'https://post.smzdm.com',
        'Referer': 'https://post.smzdm.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://post.smzdm.com/api/*',
      headers: {
        'Origin': 'https://post.smzdm.com',
        'Referer': 'https://post.smzdm.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 从投稿页面获取用户信息
      const response = await this.runtime.fetch('https://post.smzdm.com/tougao/', {
        method: 'GET',
        credentials: 'include',
      })

      const html = await response.text()

      // 方法1: 从神策数据中提取用户ID
      // "login_id":"7282231564"
      const loginIdMatch = html.match(/"login_id"\s*:\s*"(\d+)"/)
      if (loginIdMatch) {
        // 尝试提取用户名
        const usernameMatch = html.match(/"值友(\d+)"/) || html.match(/class="[^"]*user-name[^"]*"[^>]*>([^<]+)</)

        return {
          isAuthenticated: true,
          userId: loginIdMatch[1],
          username: usernameMatch ? usernameMatch[1] : `值友${loginIdMatch[1]}`,
        }
      }

      // 方法2: 从页面中查找用户名链接
      // <a href="..." class="...">值友6711161468</a>
      const userLinkMatch = html.match(/class="[^"]*user-info[^"]*"[^>]*>[\s\S]*?>([^<]+)<\/a>/i)
      if (userLinkMatch) {
        const username = userLinkMatch[1].trim()
        // 从用户名中提取ID
        const userIdMatch = username.match(/值友(\d+)/)
        return {
          isAuthenticated: true,
          userId: userIdMatch ? userIdMatch[1] : username,
          username: username,
        }
      }

      // 方法3: 检查是否有退出登录链接
      if (html.includes('退出登录') || html.includes('logout')) {
        return {
          isAuthenticated: true,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 1. 创建新文章（获取 article_id）
      this.currentArticleId = await this.createArticle()

      // 2. 处理图片上传
      let content = article.html || ''

      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['smzdm.com', 'zdmimg.com', 'a.zdmimg.com', 'eimg.smzdm.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 3. 先初始化草稿上下文（编辑器真实流程会先请求该接口）
      await this.initDraft(this.currentArticleId)

      // 4. 自动保存正文（站点真实保存入口）
      await this.saveDraft(this.currentArticleId, article.title, content)

      // 4. 构建草稿 URL
      const draftUrl = `https://post.smzdm.com/edit/${this.currentArticleId}`

      return this.createResult(true, {
        postId: this.currentArticleId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 初始化草稿上下文，并缓存服务端返回的表单默认值
   */
  private async initDraft(articleId: string): Promise<void> {
    const initUrls = [
      `https://post.smzdm.com/api/draft/${articleId}`,
      `https://post.smzdm.com/post/api/draft/${articleId}`,
    ]
    for (const initUrl of initUrls) {
      const response = await this.runtime.fetch(initUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*',
        },
        body: JSON.stringify({}),
      })
      try {
        const data = await this.parseJsonOrThrow<SmzdmDraftResponse & { data?: Record<string, unknown> }>(
          response,
          `初始化草稿(${initUrl})`
        )
        if (data.error_code && data.error_code !== 0) {
          continue
        }
        this.draftMeta = (data.data && typeof data.data === 'object') ? data.data : {}
        return
      } catch (error) {
      }
    }
    this.draftMeta = {}
  }

  /**
   * 统一解析 JSON，避免 HTML 响应导致 Unexpected token '<'
   */
  private async parseJsonOrThrow<T>(response: Response, context: string): Promise<T> {
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(
        `${context} 返回非 JSON: status=${response.status}, url=${response.url}, body=${text.slice(0, 180)}`
      )
    }
  }

  /**
   * 创建新文章
   */
  private async createArticle(): Promise<string> {
    // 通过访问投稿页面获取或创建 article_id
    const response = await this.runtime.fetch('https://post.smzdm.com/tougao/', {
      method: 'GET',
      credentials: 'include',
    })

    const html = await response.text()

    // 从页面中提取已有的编辑器链接
    // /edit/aqr37vpk
    const editUrlMatch = html.match(/\/edit\/([a-zA-Z0-9]+)/)
    if (editUrlMatch) {
      return editUrlMatch[1]
    }

    // 如果没有找到，兜底创建草稿 ID
    const fallbackId = Math.random().toString(36).slice(2, 10)
    let createData: SmzdmDraftResponse | null = null
    const draftInitUrls = [
      `https://post.smzdm.com/api/draft/${fallbackId}`,
      `https://post.smzdm.com/post/api/draft/${fallbackId}`,
    ]
    for (const draftInitUrl of draftInitUrls) {
      const createResponse = await this.runtime.fetch(draftInitUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*',
        },
        body: JSON.stringify({}),
      })
      try {
        createData = await this.parseJsonOrThrow<SmzdmDraftResponse>(
          createResponse,
          `创建草稿(${draftInitUrl})`
        )
        break
      } catch (error) {
      }
    }
    if (!createData) {
      return fallbackId
    }

    if (createData.error_code && createData.error_code !== 0) {
      throw new Error(createData.error_msg || '创建文章失败')
    }

    if (createData.data?.article_id) {
      return createData.data.article_id
    }

    // 最后尝试从 URL 中提取
    const urlMatch = createData.data?.article_url?.match(/\/edit\/([a-zA-Z0-9]+)/)
    if (urlMatch) {
      return urlMatch[1]
    }

    // 服务端未返回 ID 时，使用已提交的兜底 ID 继续后续自动保存流程
    return fallbackId
  }

  /**
   * 保存草稿
   */
  private async saveDraft(articleId: string, title: string, content: string): Promise<void> {
    const wne = this.getTextCount(content)
    const awne = await this.generateAwne(wne)
    // 基于真实抓包：提交体为 application/x-www-form-urlencoded，且字段集合需精简对齐。
    // 服务端会根据已有草稿上下文补齐其余状态，额外字段可能触发风控/参数校验失败。
    const payload = new URLSearchParams({
      article_id: articleId,
      submit_type: 'auto_save',
      title,
      series_title: (this.draftMeta.series_title as string) || '',
      focus_image: (this.draftMeta.article_image_url as string) || '',
      series_order_id: String(Number(this.draftMeta.series_order_id ?? 0)),
      series_id: String(Number(this.draftMeta.series_id ?? 0)),
      anonymous: String(Number(this.draftMeta.anonymous ?? 0)),
      first_publish: String(Number(this.draftMeta.first_publish ?? 0)),
      remark: (this.draftMeta.remark as string) || '',
      editorValue: content,
      create_state_type: String(Number(this.draftMeta.create_state_type ?? 3)),
      ai_state_type: String(Number(this.draftMeta.ai_state_type ?? 3)),
      square_pic_url: (this.draftMeta.square_pic_url as string) || '',
      cover_image_rectangle: (this.draftMeta.cover_image_rectangle as string) || '',
      custom_topics: '',
      group_id: (this.draftMeta.group_id as string) || '',
      awne,
      wne: String(wne),
    })
    const submitUrls = [
      'https://post.smzdm.com/api/editor/article/submit',
      'https://post.smzdm.com/post/api/editor/article/submit',
    ]
    let data: SmzdmSubmitResponse | null = null
    let lastError = '保存草稿失败'
    for (const submitUrl of submitUrls) {
      const response = await this.runtime.fetch(submitUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*',
        },
        body: payload.toString(),
      })
      try {
        data = await this.parseJsonOrThrow<SmzdmSubmitResponse>(
          response,
          `保存草稿(${submitUrl})`
        )
        break
      } catch (error) {
        lastError = (error as Error).message
      }
    }
    if (!data) {
      throw new Error(lastError)
    }

    if (data.error_code && data.error_code !== 0) {
      throw new Error(`保存草稿失败[code=${data.error_code}]: ${data.error_msg || '未知错误'}`)
    }

  }

  /**
   * 估算正文文本字数（与编辑器 getTextCount 的核心意图一致）
   */
  private getTextCount(html: string): number {
    let text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[\n\r\t]/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")

    // 对齐站点编辑器的 xs() 计数思路：
    // 1) 中文字符按 1 计
    // 2) 全角/特殊标点按 1 计
    // 3) emoji 按 2 计
    // 4) 剩余字符按 0.5 向上取整
    const CJK_REGEX = /[\u4e00-\u9fa5]/g
    const PUNCT_REGEX = /[\u3000-\u303F\uFF00-\uFFEF\u201c\u201d\u2018\u2019\u2014\u2026\u2013\u3000\xa5]/g
    // 站点内置 regex 极长，这里用 Unicode 属性近似同类 emoji 集合
    const EMOJI_REGEX = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/gu

    const cjkMatches = text.match(CJK_REGEX)
    const cjkCount = cjkMatches ? cjkMatches.length : 0
    text = text.replace(CJK_REGEX, '')

    const punctMatches = text.match(PUNCT_REGEX)
    const punctCount = punctMatches ? punctMatches.length : 0
    text = text.replace(PUNCT_REGEX, '')

    const emojiMatches = text.match(EMOJI_REGEX)
    const emojiCount = emojiMatches ? emojiMatches.length : 0
    text = text.replace(EMOJI_REGEX, '')

    const halfCount = Math.ceil(text.length * 0.5)
    return cjkCount + punctCount + 2 * emojiCount + halfCount
  }

  /**
   * 读取 smzdm_id 并按站点前端算法生成 awne
   */
  private async generateAwne(wne: number): Promise<string> {
    let smzdmId = ''
    try {
      if (this.runtime.getCookie) {
        smzdmId = (await this.runtime.getCookie('.smzdm.com', 'smzdm_id'))
          || (await this.runtime.getCookie('post.smzdm.com', 'smzdm_id'))
          || (await this.runtime.getCookie('smzdm.com', 'smzdm_id'))
          || ''
      }
      if (!smzdmId) {
        const cookies = [
          ...(await this.runtime.cookies.get('.smzdm.com')),
          ...(await this.runtime.cookies.get('post.smzdm.com')),
          ...(await this.runtime.cookies.get('smzdm.com')),
        ]
        smzdmId = cookies.find(c => c.name === 'smzdm_id')?.value || ''
      }
    } catch (error) {
    }
    if (!smzdmId) {
      return ''
    }

    // 前端算法：
    // secret = `${smzdm_id}-${wne}-smzdm.com`
    // key = Utf8.parse(MD5(secret).toString())
    // plain = Hex.stringify(Utf8.parse(String(wne)))
    // awne = Hex.stringify(AES.encrypt(plain, key, { mode: ECB, padding: Pkcs7 }).ciphertext)
    const secret = `${smzdmId}-${wne}-smzdm.com`
    const keyMd5 = jsMd5(secret.trim())
    const key = CryptoJS.enc.Utf8.parse(keyMd5)
    const plainHex = CryptoJS.enc.Hex.stringify(CryptoJS.enc.Utf8.parse(String(wne)))
    const encrypted = CryptoJS.AES.encrypt(plainHex, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    })
    // 真实前端返回 Base64（抓包可见 awne 含 '=='），不能使用 Hex。
    const awne = CryptoJS.enc.Base64.stringify(encrypted.ciphertext)
    return awne
  }

  /**
   * 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.currentArticleId) {
      return { url: src }
    }

    try {
      // 微信文章里的图片 URL 可能包含 HTML 实体和锚点，需先标准化再下载
      const normalizedSrc = src.replace(/&amp;/g, '&').replace(/#.*$/, '')
      let blob: Blob

      if (normalizedSrc.startsWith('data:')) {
        blob = await fetch(normalizedSrc).then(r => r.blob())
      } else {
        const response = await this.runtime.fetch(normalizedSrc, {
          method: 'GET',
        })

        if (!response.ok) {
          return { url: src }
        }

        blob = await response.blob()
      }

      // 下载到非图片内容（例如反爬返回 HTML）时，保留原图链接避免插入损坏图片
      if (!blob.type.startsWith('image/')) {
        return { url: src }
      }

      // 历史版本编辑器存在两种上传路径，优先使用 /api，404 时回退 /post/api
      const uploadUrls = [
        'https://post.smzdm.com/api/images/upload/local',
        'https://post.smzdm.com/post/api/images/upload/local',
      ]
      let data: SmzdmImageResponse | null = null
      for (const uploadUrl of uploadUrls) {
        // 每次重建 FormData，避免请求体在某些运行时被消费后重试失败
        const formData = new FormData()
        formData.append('imgFile', blob, `image_${Date.now()}.jpg`)
        formData.append('id', 'WU_FILE_0')
        formData.append('type', blob.type || 'image/png')
        formData.append('article_id', this.currentArticleId)

        const uploadResponse = await this.runtime.fetch(uploadUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/plain, */*',
          },
          body: formData,
        })
        const responseText = await uploadResponse.text()
        try {
          data = JSON.parse(responseText) as SmzdmImageResponse
          break
        } catch {
          if (uploadResponse.status === 404) continue
        }
      }
      if (!data) {
        return { url: src }
      }

      if (data.error_code && data.error_code !== 0) {
        return { url: src }
      }

      if (data.data?.url) {
        return { url: data.data.url }
      }

      return { url: src }
    } catch (error) {
      return { url: src }
    }
  }
}
