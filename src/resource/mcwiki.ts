import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

// Minecraft Wiki API 的基本URL
const WIKI_API_BASE = 'https://minecraft.fandom.com/zh/api.php'

// 搜索 Minecraft Wiki
export async function searchMcwikiPages(ctx: Context, keyword: string, options = {}) {
  try {
    // 构建搜索参数
    const params: any = {
      action: 'query',
      list: 'search',
      srsearch: keyword,
      format: 'json'
    }

    // 指定命名空间
    if (options['namespace']) params.srnamespace = options['namespace']

    // 设置搜索限制
    if (options['limit'] && !isNaN(options['limit'])) {
      params.srlimit = Math.min(Math.max(1, options['limit']), 50) // 1-50之间
    }

    const response = await ctx.http.get(WIKI_API_BASE, { params })
    return response.query?.search || []
  } catch (error) {
    ctx.logger.error('Wiki 页面搜索失败:', error)
    return []
  }
}

// 获取 Wiki 页面详情
export async function getMcwikiPage(ctx: Context, pageId: number) {
  try {
    // 获取基本页面信息
    const response = await ctx.http.get(WIKI_API_BASE, {
      params: {
        action: 'query',
        pageids: pageId,
        prop: 'info|extracts|categories|links|images',
        inprop: 'url',
        exintro: true,
        explaintext: true,
        cllimit: 5,  // 最多5个分类
        pllimit: 5,  // 最多5个链接
        imlimit: 3,  // 最多3张图片
        format: 'json'
      }
    })

    if (response.query?.pages) {
      const page = response.query.pages[pageId]
      if (!page) return null

      // 提取分类信息
      const categories = page.categories?.map(c => c.title.replace('Category:', '')) || []

      // 提取相关链接
      const links = page.links?.map(l => l.title) || []

      // 提取图片（可选）
      const images = page.images?.map(i => i.title.replace('File:', '')) || []

      let content = `
# ${page.title}

${page.extract?.substring(0, 500) || '无法获取页面摘要'}${page.extract?.length > 500 ? '...' : ''}`

      // 添加分类信息
      if (categories.length > 0) {
        content += `\n\n## 分类\n${categories.join(', ')}`
      }

      // 添加相关链接
      if (links.length > 0) {
        content += `\n\n## 相关页面\n- ${links.join('\n- ')}`
      }

      content += `\n\n[查看完整页面](${page.fullurl})`
      return content.trim()
    }
    return null
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
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        // 构造搜索选项
        const searchOptions: any = {}

        // 处理精确匹配
        if (options.exact) {
          keyword = `"${keyword}"` // 添加引号表示精确匹配
        }

        // 处理分类筛选
        if (options.category) {
          keyword = `${keyword} incategory:"${options.category}"`
        }

        // 搜索页面
        const pages = await searchMcwikiPages(ctx, keyword, searchOptions)
        if (pages.length === 0) return '未找到匹配的Wiki条目'

        // 显示第一个结果
        const content = await getMcwikiPage(ctx, pages[0].pageid)
        if (!content) return '获取Wiki页面详情失败'

        return renderOutput(session, content, config.outputMode, ctx)
      } catch (error) {
        ctx.logger.error('Wiki 查询失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
