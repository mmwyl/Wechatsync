/**
 * 电子发烧友适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Elecfans')

interface ElecfansAuthResponse {
  uid?: string
  username?: string
  avatar?: string
  code?: number
  data?: {
    uid?: string | number
    username?: string
    avatar?: string
  }
}

interface ElecfansApiResponse<T = unknown> {
  code: number
  msg?: string
  data?: T
  type?: number
}

interface ElecfansDraftData {
  aid: number
  url?: string
}

export class ElecfansAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'elecfans',
    name: '电子发烧友',
    icon: 'https://www.elecfans.com/favicon.ico',
    homepage: 'https://www.elecfans.com/mycenter/article',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 电子发烧友使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private currentDraftId: string | null = null

  /** 电子发烧友 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.elecfans.com/webapi/*',
      headers: {
        Origin: 'https://www.elecfans.com',
        Referer: 'https://www.elecfans.com/d/article/write',
        'X-Requested-With': 'XMLHttpRequest',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const authUrls = [
        `https://www.elecfans.com/webapi/passport/checklogin?_=${Date.now()}`,
        `https://www.elecfans.com/webapi/passport/checkloginsz?_=${Date.now()}`,
      ]

      for (const url of authUrls) {
        try {
          const response = await this.runtime.fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
              Accept: 'application/json, text/javascript, */*; q=0.01',
              'X-Requested-With': 'XMLHttpRequest',
            },
          })
          const text = await response.text()
          const parsed = this.parseAuthResponse(text)
          const auth = this.normalizeAuth(parsed)
          if (auth.isAuthenticated) {
            return auth
          }
        } catch (error) {
          logger.debug('checkAuth endpoint failed:', url, error)
        }
      }

      return { isAuthenticated: false }
    }).catch((error) => {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    })
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录电子发烧友')
      }

      let content = article.html || ''
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          // 避免重复上传已经在站内的图片
          skipPatterns: ['file1.elecfans.com', 'file.elecfans.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 先创建草稿，拿到 aid；这样后续 save 接口可以稳定更新同一篇草稿。
      const addBody = new URLSearchParams({
        title: article.title,
        content,
        draft: '1',
        is_md: '2',
        relate_video_id: '',
      }).toString()

      const addResponse = await this.runtime.fetch(
        'https://www.elecfans.com/webapi/Mcenter/Article/addArticle',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: addBody,
        }
      )

      const addRes = await addResponse.json() as ElecfansApiResponse<ElecfansDraftData>
      if (addRes.code !== 0 || !addRes.data?.aid) {
        throw new Error(addRes.msg || '创建草稿失败')
      }

      this.currentDraftId = String(addRes.data.aid)

      const saveBody = new URLSearchParams({
        title: article.title,
        content,
        draft: '1',
        is_md: '2',
        relate_video_id: '',
        id: this.currentDraftId,
      }).toString()

      const saveResponse = await this.runtime.fetch(
        'https://www.elecfans.com/webapi/Mcenter/Article/save',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: saveBody,
        }
      )

      const saveRes = await saveResponse.json() as ElecfansApiResponse<ElecfansDraftData>
      logger.debug('Save response:', saveRes)

      if (saveRes.code !== 0 || !saveRes.data?.aid) {
        throw new Error(saveRes.msg || '保存草稿失败')
      }

      const draftId = String(saveRes.data.aid)

      return this.createResult(true, {
        postId: draftId,
        // 接口返回的 url 可能是公开文章页或中间跳转页，不适合作为草稿编辑入口。
        // 草稿应固定跳转到写文章编辑页并带 id 参数。
        postUrl: `https://www.elecfans.com/d/article/write?id=${draftId}`,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 下载图片使用全局 fetch，兼容外链图片获取；上传走 runtime.fetch 以复用登录态。
    const imageResponse = await fetch(src, {
      headers: {
        Referer: 'https://mp.weixin.qq.com/',
      },
    })
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const ext = this.getImageExtension(imageBlob.type, src)
    const filename = `image-${Date.now()}.${ext}`
    const formData = new FormData()
    formData.append('Filedata', imageBlob, filename)

    const uploadResponse = await this.runtime.fetch(
      'https://www.elecfans.com/webapi/Mcenter/ComApi/uploadDoc',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: formData,
      }
    )

    const res = await uploadResponse.json() as ElecfansApiResponse<{
      url?: string
      name?: string
      size?: string
      type?: string
    }>

    if (res.code !== 0 || !res.data?.url) {
      throw new Error(res.msg || '图片上传失败')
    }

    return { url: res.data.url }
  }

  private getImageExtension(mimeType: string, src: string): string {
    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
    }
    const byMime = mimeMap[(mimeType || '').toLowerCase()]
    if (byMime) return byMime

    const byUrl = src.split('.').pop()?.toLowerCase()?.split('?')[0] || 'jpg'
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(byUrl)) {
      return byUrl === 'jpeg' ? 'jpg' : byUrl
    }
    return 'jpg'
  }

  private parseAuthResponse(text: string): ElecfansAuthResponse {
    const trimmed = (text || '').trim()
    if (!trimmed) return {}

    try {
      return JSON.parse(trimmed) as ElecfansAuthResponse
    } catch {
      // 兼容 JSONP/包裹响应，尽量从文本中提取 JSON 主体
      const objectMatch = trimmed.match(/\{[\s\S]*\}$/)
      if (!objectMatch) return {}
      try {
        return JSON.parse(objectMatch[0]) as ElecfansAuthResponse
      } catch {
        return {}
      }
    }
  }

  private normalizeAuth(res: ElecfansAuthResponse): AuthResult {
    const uid =
      (typeof res.uid !== 'undefined' ? String(res.uid) : undefined) ||
      (typeof res.data?.uid !== 'undefined' ? String(res.data.uid) : undefined)

    const username = res.username || res.data?.username
    const avatar = res.avatar || res.data?.avatar

    if (uid && uid !== '0') {
      return {
        isAuthenticated: true,
        userId: uid,
        username,
        avatar,
      }
    }

    return { isAuthenticated: false }
  }
}
