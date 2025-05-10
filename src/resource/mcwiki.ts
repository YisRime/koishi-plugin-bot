import { Context, Command } from 'koishi'
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
    ctx.logger.error('Wiki 页面搜索失败:', error)
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
        prop: 'info|extracts|categories|links',
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

    // 整合页面信息
    const url = page.fullurl
    const content = [
      `# ${page.title}`,
      page.extract,
      page.categories?.length ? `\n## 分类\n${page.categories.map(c => c.title.replace('Category:', '')).join(', ')}` : '',
      page.links?.length ? `\n## 相关页面\n- ${page.links.map(l => l.title).join('\n- ')}` : '',
      `\n[查看完整页面](${url})`
    ].filter(Boolean).join('\n\n')

    return { content, url }
  } catch (error) {
    ctx.logger.error('Wiki 页面详情获取失败:', error)
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
        // 构建搜索关键词
        let searchKey = keyword
        if (options.exact) searchKey = `"${searchKey}"`
        if (options.category) searchKey += ` incategory:"${options.category}"`

        const pages = await searchMcwikiPages(ctx, searchKey)
        if (!pages.length) return '未找到匹配的Wiki条目'

        const pageInfo = await getMcwikiPage(ctx, pages[0].pageid)
        if (!pageInfo) return '获取Wiki页面详情失败'

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
