import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

const MCMOD_API_BASE = 'https://search.mcmod.cn/s'

// 搜索MCMOD资源
export async function searchMcmodProjects(ctx: Context, keyword: string, options = {}) {
  try {
    const params = {
      key: keyword,
      format: 'json',
      ...(options['type'] ? { type: options['type'] } : {})
    }

    const response = await ctx.http.get(MCMOD_API_BASE, { params })
    return response.data || []
  } catch (error) {
    ctx.logger.error('MCMOD 资源搜索失败:', error)
    return []
  }
}

// 获取MCMOD额外信息
async function fetchMcmodProjectDetail(ctx: Context, id: string) {
  try {
    const html = await ctx.http.get(`https://www.mcmod.cn/item/${id}.html`)

    // 提取重要信息
    const downloadLink = (html.match(/<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*download[^"']*["'][^>]*>/i) || [])[1]
    const descMatch = html.match(/<div[^>]*class=["'][^"']*intro[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    const description = descMatch ? descMatch[1]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() : null

    return { downloadLink, description }
  } catch (error) {
    ctx.logger.error('MCMOD 附加信息获取失败:', error)
    return {}
  }
}

// 处理MCMOD资源详情
export async function getMcmodProject(ctx: Context, project) {
  const extraInfo = project.extra?.id ? await fetchMcmodProjectDetail(ctx, project.extra.id) : {}

  // 构建内容
  const content = [
    `# ${project.name}`,
    extraInfo.description || project.description || '暂无描述',
    [
      `类型: ${project.extra?.type || '未知'}`,
      `游戏版本: ${project.extra?.mcversion || '未知'}`,
      extraInfo.downloadLink ? `下载链接: ${extraInfo.downloadLink}` : null
    ].filter(Boolean).map(item => `- ${item}`).join('\n'),
    `[查看详情](${project.url})`
  ].filter(Boolean).join('\n\n')

  return { content, url: project.url }
}

// 注册 mcmod 命令
export function registerMcmod(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.mod <keyword:text>', '查询 MCMOD 百科')
    .option('type', '-t <type:string> 类型')
    .option('version', '-v <version:string> 游戏版本')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        // 搜索并过滤
        let projects = await searchMcmodProjects(ctx, keyword, { type: options.type })

        if (options.version && projects.length) {
          projects = projects.filter(p => !p.mcversion || p.mcversion.includes(options.version))
        }

        if (!projects.length) return '未找到匹配的MCMOD条目'

        // 处理第一个结果
        const projectData = {
          name: projects[0].name,
          description: projects[0].description,
          url: `https://www.mcmod.cn/item/${projects[0].id}.html`,
          extra: { id: projects[0].id, type: projects[0].type, mcversion: projects[0].mcversion }
        }

        const projectInfo = await getMcmodProject(ctx, projectData)
        const result = await renderOutput(
          session, projectInfo.content, projectInfo.url, ctx, config, options.shot
        )

        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('MCMOD 查询失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
