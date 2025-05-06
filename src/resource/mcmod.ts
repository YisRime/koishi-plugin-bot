import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

// MCMOD API 的基本URL
const MCMOD_API_BASE = 'https://search.mcmod.cn/s'

// 搜索 MCMOD 资源列表
export async function searchMcmodProjects(ctx: Context, keyword: string, options = {}) {
  try {
    // 构建搜索参数
    const params: any = {
      key: keyword,
      format: 'json'
    }

    // MCMOD API目前不支持更多参数，但保留扩展性
    if (options['type']) params.type = options['type']

    const response = await ctx.http.get(MCMOD_API_BASE, { params })
    return response.data || []
  } catch (error) {
    ctx.logger.error('MCMOD 资源搜索失败:', error)
    return []
  }
}

// 获取MCMOD资源的更多信息（简单爬取页面）
async function fetchMcmodProjectDetail(ctx: Context, id: string) {
  try {
    const html = await ctx.http.get(`https://www.mcmod.cn/item/${id}.html`)

    // 这里可以添加简单的HTML解析来提取更多信息
    // 但由于MCMOD没有提供API，这里只做基本处理

    // 提取下载链接
    let downloadLink = null
    const downloadMatch = html.match(/<a[^>]*href=["']([^"']+)["'][^>]*class=["']([^"']*download[^"']*)["'][^>]*>/i)
    if (downloadMatch) downloadLink = downloadMatch[1]

    // 提取详细描述（简化处理）
    let description = ''
    const descMatch = html.match(/<div[^>]*class=["']([^"']*intro[^"']*)["'][^>]*>([\s\S]*?)<\/div>/i)
    if (descMatch) {
      description = descMatch[2]
        .replace(/<[^>]*>/g, '') // 移除HTML标签
        .replace(/&nbsp;/g, ' ')  // 替换HTML实体
        .trim()
    }

    return {
      downloadLink,
      description: description || null
    }
  } catch (error) {
    ctx.logger.error('MCMOD 附加信息获取失败:', error)
    return null
  }
}

// 格式化单个资源详情
export async function getMcmodProject(ctx: Context, project) {
  // 尝试获取更多资源信息
  let extraInfo = null
  if (project.extra?.id) {
    extraInfo = await fetchMcmodProjectDetail(ctx, project.extra.id)
  }

  let content = `
# ${project.name}

${project.description || extraInfo?.description || '暂无描述'}

- 类型: ${project.extra?.type || '未知'}
- 游戏版本: ${project.extra?.mcversion || '未知'}`

  // 添加下载链接（如果有）
  if (extraInfo?.downloadLink) {
    content += `\n- 下载链接: ${extraInfo.downloadLink}`
  }

  // 添加关键词和标签
  if (project.extra?.tags && project.extra.tags.length > 0) {
    content += `\n- 标签: ${project.extra.tags.join(', ')}`
  }

  content += `\n\n[查看详情](${project.url})`
  return content.trim()
}

// 注册 mcmod 命令
export function registerMcmod(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.mod <keyword:text>', '查询 MCMOD 百科')
    .option('type', '-t <type:string> 类型(mod/item/entity/block)')
    .option('version', '-v <version:string> 游戏版本(如1.20.1)')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        // 构造搜索选项
        const searchOptions: any = {}
        if (options.type) searchOptions.type = options.type
        // 由于API限制，版本筛选需在客户端完成

        // 搜索资源
        let projects = await searchMcmodProjects(ctx, keyword, searchOptions)

        // 客户端版本过滤
        if (options.version && projects.length > 0) {
          projects = projects.filter(p =>
            !p.mcversion || p.mcversion.includes(options.version)
          )
        }

        if (projects.length === 0) return '未找到匹配的MCMOD条目'

        // 选择第一个结果
        const firstProject = projects[0]

        // 转换为统一格式
        const projectData = {
          name: firstProject.name,
          description: firstProject.description || '暂无描述',
          url: `https://www.mcmod.cn/item/${firstProject.id}.html`,
          extra: {
            id: firstProject.id,
            type: firstProject.type,
            mcversion: firstProject.mcversion,
            tags: firstProject.tags || []
          }
        }

        // 获取并展示详情
        const content = await getMcmodProject(ctx, projectData)
        return renderOutput(session, content, config.outputMode, ctx)
      } catch (error) {
        ctx.logger.error('MCMOD 查询失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
