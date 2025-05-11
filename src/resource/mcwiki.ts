import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

const WIKI_API_BASE = 'https://zh.minecraft.wiki/api.php'

// 搜索Wiki页面
export async function searchMcwikiPages(ctx: Context, keyword: string, options = {}) {
  try {
    const response = await ctx.http.get(WIKI_API_BASE, {
      params: {
        action: 'query',
        list: 'search',
        srsearch: keyword,
        format: 'json',
        srlimit: options['limit'] || 10,
        ...(options['namespace'] ? { srnamespace: options['namespace'] } : {})
      }
    })
    return response.query?.search || []
  } catch (error) {
    ctx.logger.error('Minecraft Wiki 搜索失败:', error)
    return []
  }
}

// 获取Wiki页面详情
export async function getMcwikiPage(ctx: Context, pageId: number) {
  try {
    // 获取页面基本信息
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

    // 获取第一张图片
    let imageUrl = null
    if (page.images?.length > 0) {
      try {
        const imgResponse = await ctx.http.get(WIKI_API_BASE, {
          params: {
            action: 'query',
            titles: page.images[0].title,
            prop: 'imageinfo',
            iiprop: 'url',
            format: 'json'
          }
        })
        const imgPages = imgResponse.query?.pages
        if (imgPages) {
          imageUrl = imgPages[Object.keys(imgPages)[0]]?.imageinfo?.[0]?.url
        }
      } catch (error) {
        ctx.logger.error('Minecraft Wiki 图片获取失败:', error)
      }
    }

    // 构建内容
    const content = [
      `[${page.title}]`,
      imageUrl && h.image(imageUrl),
      page.extract,
      page.categories?.length && `◆ 分类 ◆\n${page.categories.map(c => c.title.replace('Category:', '')).join(', ')}`,
      page.links?.length && `◆ 相关页面 ◆\n${page.links.map(l => `● ${l.title}`).join('\n')}`,
      `查看完整页面: ${page.fullurl}`
    ].filter(Boolean)

    return {
      content,
      url: page.fullurl,
      icon: imageUrl
    }
  } catch (error) {
    ctx.logger.error('Minecraft Wiki 详情获取失败:', error)
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
      if (!keyword) return '请输入关键词'

      try {
        // 构建搜索词
        let searchKey = options.exact ? `"${keyword}"` : keyword
        if (options.category) searchKey += ` incategory:"${options.category}"`

        const pages = await searchMcwikiPages(ctx, searchKey)
        if (!pages.length) return '未找到匹配的条目'

        const pageInfo = await getMcwikiPage(ctx, pages[0].pageid)
        if (!pageInfo) return '获取详情失败'

        const result = await renderOutput(
          session, pageInfo.content, pageInfo.url, ctx, config, options.shot
        )

        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('Minecraft Wiki 查询失败:', error)
        return '查询时出错'
      }
    })
}
