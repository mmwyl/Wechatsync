/**
 * 搜狐号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Sohu')

interface SohuAccountInfo {
  id: string
  nickName: string
  avatar: string
}

/**
 * 生成设备 ID (dv-id)
 */
function generateDeviceId(): string {
  const chars = '0123456789abcdef'
  let result = ''
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export class SohuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohu',
    name: '搜狐号',
    icon: 'https://mp.sohu.com/favicon.ico',
    homepage: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 搜狐号使用 HTML 格式，需要处理代码块 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    processCodeBlocks: true,
  }

  private accountInfo: SohuAccountInfo | null = null
  private deviceId: string = generateDeviceId()
  private spCm: string = ''

  /** 搜狐号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.sohu.com/*',
      headers: {
        'Origin': 'https://mp.sohu.com',
        'Referer': 'https://mp.sohu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 使用 /account/list 获取所有子账号（搜狐号支持多个子账号）
      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/account/list?_=${Date.now()}`,
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          data?: Array<{
            accounts: SohuAccountInfo[]
          }>
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.code !== 2000000 || !res.data?.data?.[0]?.accounts?.length) {
        return { isAuthenticated: false }
      }

      // 收集所有子账号
      const allAccounts: SohuAccountInfo[] = []
      for (const group of res.data.data) {
        if (group.accounts) {
          allAccounts.push(...group.accounts)
        }
      }

      if (allAccounts.length === 0) {
        return { isAuthenticated: false }
      }

      // 默认使用第一个子账号
      this.accountInfo = allAccounts[0]
      logger.info(`Using account: ${this.accountInfo.nickName} (id: ${this.accountInfo.id})` +
        (allAccounts.length > 1 ? `, ${allAccounts.length} sub-accounts available` : ''))

      // 获取 mp-cv cookie 用于 sp-cm header
      await this.fetchSpCm()

      // 如果有多个子账号，在用户名中标注
      const displayName = allAccounts.length > 1
        ? `${this.accountInfo.nickName} (共${allAccounts.length}个子账号)`
        : this.accountInfo.nickName

      return {
        isAuthenticated: true,
        userId: String(this.accountInfo.id),
        username: displayName,
        avatar: this.accountInfo.avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取 sp-cm 值 (从 cookie 或生成)
   */
  private async fetchSpCm(): Promise<void> {
    try {
      // 尝试通过 runtime 获取 cookie（如果支持）
      if (this.runtime.getCookie) {
        const cookieValue = await this.runtime.getCookie('.sohu.com', 'mp-cv')
        if (cookieValue) {
          this.spCm = cookieValue
          logger.debug('Got sp-cm from cookie:', this.spCm)
          return
        }
      }
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      logger.debug('Generated sp-cm:', this.spCm)
    } catch (error) {
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      logger.debug('Fallback sp-cm:', this.spCm)
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 确保已登录
      if (!this.accountInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录搜狐号')
        }
      }

      // Use pre-preprocessed HTML content directly
      let content = article.html || ''

      // 搜狐号专用：处理代码块换行问题
      content = this.fixCodeBlocksForSohu(content)

      // Process images
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['sohu.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 4. 保存草稿 (v2 API - JSON 格式)
      const postData = {
        title: article.title,
        brief: '',
        content: content,
        channelId: 24,
        categoryId: -1,
        id: 0,
        userColumnId: 0,
        columnNewsIds: [],
        businessCode: 0,
        declareOriginal: false,
        cover: '',
        topicIds: [],
        isAd: 0,
        userLabels: '[]',
        reprint: false,
        customTags: '',
        infoResource: 0,
        sourceUrl: '',
        visibleToLoginedUsers: 0,
        attrIds: [],
        auto: true,
        accountId: Number(this.accountInfo!.id),
      }

      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2?accountId=${this.accountInfo!.id}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'dv-id': this.deviceId,
            'sp-cm': this.spCm,
          },
          body: JSON.stringify(postData),
        }
      )

      const res = await response.json() as {
        success: boolean
        data?: string | number
        msg?: string
      }

      logger.debug(' Save response:', res)

      if (!res.success) {
        throw new Error(res.msg || '保存失败')
      }

      const postId = res.data
      const draftUrl = `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=${postId}`

      return this.createResult(true, {
        postId: String(postId),
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.accountInfo) {
      throw new Error('未登录')
    }

    // 1. 下载图片（添加 referer 头以绕过防盗链）
    const imageResponse = await fetch(src, {
      headers: {
        'Referer': 'https://mp.weixin.qq.com/',
      },
    })
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 上传到搜狐
    const formData = new FormData()
    formData.append('file', imageBlob, 'image.jpg')
    formData.append('accountId', this.accountInfo.id)

    const uploadResponse = await this.runtime.fetch(
      'https://mp.sohu.com/commons/front/outerUpload/image/file?accountId='+  this.accountInfo.id,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await uploadResponse.json() as {
      url?: string
      msg?: string
    }

    logger.debug(' Image upload response:', res)
    if (!res.url) {
      throw new Error('图片上传失败:'+ (res.msg))
    }

    return {
      url: res.url,
    }
  }

  /**
   * 搜狐号专用：修复代码块换行问题
   * 搜狐编辑器会过滤 <br> 标签，使用 <div> 标签包装每一行来保留格式
   */
  private fixCodeBlocksForSohu(html: string): string {
    // 匹配 <pre> 标签及其内容
    return html.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/gi, (_match, attrs, content) => {
      // 提取 code 标签（如果存在）
      const codeMatch = content.match(/<code([^>]*)>([\s\S]*?)<\/code>/i)
      let codeAttrs = ''
      let codeContent = content

      if (codeMatch) {
        codeAttrs = codeMatch[1]
        codeContent = codeMatch[2]
      }

      // 将 <br> 替换为实际换行符
      codeContent = codeContent.replace(/<br\s*\/?>/gi, '\n')

      // 解码 HTML 实体
      codeContent = this.decodeHtmlEntities(codeContent)

      // 按行分割
      const lines = codeContent.split('\n').filter((line: string) => line.trim())

      // 使用 <div> 标签包装每一行，这样可以确保即使 <br> 被过滤，换行仍然有效
      const linesHtml = lines.map((line: string) => `<div style="font-family: Consolas, Monaco, monospace; font-size: 14px; line-height: 1.5; color: #333;">${this.escapeHtml(line)}</div>`).join('')

      // 使用 data-sohu-fixed 属性标记已处理
      if (codeMatch) {
        return `<pre${attrs} data-sohu-fixed="true"><code${codeAttrs}>${linesHtml}</code></pre>`
      } else {
        return `<pre${attrs} data-sohu-fixed="true"><code>${linesHtml}</code></pre>`
      }
    })
  }

  /**
   * 解码 HTML 实体
   */
  private decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      '&lt;': '<',
      '&gt;': '>',
      '&amp;': '&',
      '&quot;': '"',
      '&#39;': "'",
      '&nbsp;': ' ',
    }
    return text.replace(/&[a-z]+;|&#[\d]+;/gi, (match) => entities[match] || match)
  }

  /**
   * HTML 转义
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
}
