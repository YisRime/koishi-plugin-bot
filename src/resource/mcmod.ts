import { Context, Command, h } from 'koishi'
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
    ctx.logger.error('MCMOD 搜索失败:', error)
    return []
  }
}

// 简化详情获取
async function fetchMcmodProjectDetail(ctx: Context, id: string) {
  try {
    const html = await ctx.http.get(`https://www.mcmod.cn/item/${id}.html`)

    // 提取信息用正则
    const downloadMatch = html.match(/<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*download[^"']*["'][^>]*>/i)
    const descMatch = html.match(/<div[^>]*class=["'][^"']*intro[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    // 尝试获取图标URL
    const iconMatch = html.match(/<div[^>]*class=["'][^"']*col-info-img[^"']*["'][^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["'][^>]*>/i)

    return {
      downloadLink: downloadMatch && downloadMatch[1],
      description: descMatch ? descMatch[1]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() : null,
      iconUrl: iconMatch && iconMatch[1]
    }
  } catch (error) {
    ctx.logger.error('MCMOD 附加信息获取失败:', error)
    return {}
  }
}

// 处理MCMOD资源详情
export async function getMcmodProject(ctx: Context, project) {
  const extraInfo = project.extra?.id ? await fetchMcmodProjectDetail(ctx, project.extra.id) : {}

  // 构建内容
  const content = []

  // 添加标题
  content.push(`【${project.name}】`)

  // 添加图标
  if (extraInfo.iconUrl) {
    content.push(h.image(extraInfo.iconUrl))
  }

  // 添加描述
  content.push(extraInfo.description || project.description || '暂无描述')

  // 添加基本信息
  const infoItems = [
    `类型: ${project.extra?.type || '未知'}`,
    `游戏版本: ${project.extra?.mcversion || '未知'}`,
    extraInfo.downloadLink ? `下载链接: ${extraInfo.downloadLink}` : null
  ].filter(Boolean)

  if (infoItems.length > 0) {
    content.push(infoItems.map(item => `● ${item}`).join('\n'))
  }

  // 添加详情链接
  content.push(`查看详情: ${project.url}`)

  return {
    content,
    url: project.url,
    icon: extraInfo.iconUrl || null
  }
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

        // 转换为统一格式
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
