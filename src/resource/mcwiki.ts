import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

const WIKI_API_BASE = 'https://zh.minecraft.wiki/api.php'

// 搜索Wiki页面
export async function searchMcwikiPages(ctx: Context, keyword: string, options = {}) {
  try {
    const params = {
      action: 'query',
      list: 'search',
      srsearch: keyword,
      format: 'json',
      srlimit: options['limit'] || 10,
      ...(options['namespace'] ? { srnamespace: options['namespace'] } : {})
    }

    const response = await ctx.http.get(WIKI_API_BASE, { params })
    return response.query?.search || []
  } catch (error) {
    ctx.logger.error('Wiki 搜索失败:', error)
    return []
  }
}

// 获取Wiki页面详情
export async function getMcwikiPage(ctx: Context, pageId: number) {
  try {
    const response = await ctx.http.get(WIKI_API_BASE, {
      params: {
        action: 'query',
        pageids: pageId,
        prop: 'info|extracts|categories|links|images',
        inprop: 'url',
        exintro: true,
        explaintext: true,
        cllimit: 5,
        pllimit: 5,
        format: 'json'
      }
    })

    const page = response.query?.pages?.[pageId]
    if (!page) return null

    const url = page.fullurl

    // 尝试获取页面的第一个图片URL
    let imageUrl = null
    if (page.images && page.images.length > 0) {
      const firstImage = page.images[0].title
      // 获取图片的实际URL
      try {
        const imgResponse = await ctx.http.get(WIKI_API_BASE, {
          params: {
            action: 'query',
            titles: firstImage,
            prop: 'imageinfo',
            iiprop: 'url',
            format: 'json'
          }
        })
        const imgPages = imgResponse.query?.pages
        if (imgPages) {
          const imgPageId = Object.keys(imgPages)[0]
          imageUrl = imgPages[imgPageId]?.imageinfo?.[0]?.url
        }
      } catch (error) {
        ctx.logger.error('Wiki 图片获取失败:', error)
      }
    }

    // 精简内容构建
    const content = []

    // 添加标题
    content.push(`【${page.title}】`)

    // 添加图片
    if (imageUrl) {
      content.push(h.image(imageUrl))
    }

    // 添加描述
    if (page.extract) {
      content.push(page.extract)
    }

    // 添加分类信息
    if (page.categories?.length) {
      content.push(`◆ 分类 ◆\n${page.categories.map(c => c.title.replace('Category:', '')).join(', ')}`)
    }

    // 添加相关页面
    if (page.links?.length) {
      content.push(`◆ 相关页面 ◆\n${page.links.map(l => `● ${l.title}`).join('\n')}`)
    }

    // 添加页面链接
    content.push(`查看完整页面: ${url}`)

    return {
      content,
      url,
      icon: imageUrl
    }
  } catch (error) {
    ctx.logger.error('Wiki 详情获取失败:', error)
    return null
  }
}

// 注册 mcwiki 命令
export function registerMcwiki(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.wiki <keyword:text>', '查询 Minecraft Wiki')
    .option('exact', '-e 精确匹配')
    .option('category', '-c <category:string> 分类筛选')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        // 构建搜索词
        let searchKey = keyword
        if (options.exact) searchKey = `"${searchKey}"`
        if (options.category) searchKey += ` incategory:"${options.category}"`

        const pages = await searchMcwikiPages(ctx, searchKey)
        if (!pages.length) return '未找到匹配的Wiki条目'

        const pageInfo = await getMcwikiPage(ctx, pages[0].pageid)
        if (!pageInfo) return '获取Wiki详情失败'

        const result = await renderOutput(
          session, pageInfo.content, pageInfo.url, ctx, config, options.shot
        )

        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('Wiki 查询失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
