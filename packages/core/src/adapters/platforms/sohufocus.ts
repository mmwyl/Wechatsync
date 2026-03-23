/**
 * 搜狐焦点适配器
 * https://mp.focus.cn
 */
import { CodeAdapter, ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
export class SohuFocusAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: 'sohufocus',
    name: '搜狐焦点',
    icon: 'https://mp.focus.cn/favicon.ico',
    homepage: 'https://mp.focus.cn/fe/index.html#/info/draft',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 搜狐焦点使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * 检查登录状态
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://mp-fe-pc.focus.cn/user/status', {
        credentials: 'include',
      })
      const res = await response.json()

      if (!res.data?.uid) {
        return { isAuthenticated: false, error: '未登录' }
      }

      return {
        isAuthenticated: true,
        userId: res.data.uid,
        username: res.data.accountName,
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()

    // 构建 FormData
    const formData = new FormData()
    formData.append('image', blob, `${Date.now()}.jpg`)

    const response = await this.runtime.fetch(
      'https://mp-fe-pc.focus.cn/common/image/upload?type=2',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await response.json()

    if (res.code !== 200) {
      throw new Error('图片上传失败')
    }

    return { url: `https://t-img.51f.com/sh740wsh${res.data}` }
  }

  /**
   * 发布文章
   */
  async publish(article: Article): Promise<SyncResult> {
    const now = Date.now()
    try {
      // 处理图片
      let content = article.html || article.markdown || ''
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src))

      // 清理 HTML 中的多余空白
      content = content.replace(/>\s+</g, '><')

      // 发布到搜狐焦点
      const response = await this.runtime.fetch(
        'https://mp-fe-pc.focus.cn/news/info/publishNewsInfo',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            projectIds: [],
            newsBasic: {
              id: '',
              cityId: 0,
              title: article.title,
              category: 1,
              headImg: '',
              newsAbstract: '',
              isGuide: 0,
              status: 4, // 草稿
            },
            newsContent: {
              content: content,
            },
            videoIds: [],
          }),
        }
      )

      const res = await response.json()

      if (!res.data?.id) {
        throw new Error('发布失败')
      }

      return {
        platform: this.meta.id,
        success: true,
        postId: res.data.id,
        postUrl: `https://mp.focus.cn/fe/index.html#/info/subinfo/${res.data.id}`,
        draftOnly: true,
        timestamp: now,
      }
    } catch (error) {
      return {
        platform: this.meta.id,
        success: false,
        error: (error as Error).message,
        timestamp: now,
      }
    }
  }
}
