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

    // 构造并记录请求URL
    const url = new URL(MCMOD_API_BASE);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, String(value));
    });
    ctx.logger.info(`[MCMOD] 搜索请求: ${url.toString()}`);

    const response = await ctx.http.get(MCMOD_API_BASE, { params })
    return response.data || []
  } catch (error) {
    ctx.logger.error('MCMOD 搜索失败:', error)
    return []
  }
}

// 处理MCMOD资源详情
export async function getMcmodProject(ctx: Context, project) {
  // 内联之前的 fetchMcmodProjectDetail 函数
  let iconUrl, description, downloadLink;
  try {
    const detailUrl = `https://www.mcmod.cn/item/${project.extra?.id}.html`;
    ctx.logger.info(`[MCMOD] 获取详情: ${detailUrl}`);

    const html = await ctx.http.get(detailUrl)

    // 使用正则提取信息
    const downloadMatch = html.match(/<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*download[^"']*["'][^>]*>/i)
    const descMatch = html.match(/<div[^>]*class=["'][^"']*intro[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    const iconMatch = html.match(/<div[^>]*class=["'][^"']*col-info-img[^"']*["'][^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["'][^>]*>/i)

    iconUrl = iconMatch?.[1]
    description = descMatch?.[1]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
    downloadLink = downloadMatch?.[1]
  } catch (error) {
    ctx.logger.error('MCMOD 附加信息获取失败:', error)
  }

  // 构建内容
  const content = [
    `[${project.name}]`,
    iconUrl && h.image(iconUrl),
    description || project.description || '暂无描述',
    [
      `类型: ${project.extra?.type || '未知'}`,
      `游戏版本: ${project.extra?.mcversion || '未知'}`,
      downloadLink && `下载链接: ${downloadLink}`
    ].filter(Boolean).map(item => `● ${item}`).join('\n'),
    `查看详情: ${project.url}`
  ].filter(Boolean)

  return {
    content,
    url: project.url,
    icon: iconUrl || null
  }
}

// 注册 mcmod 命令
export function registerMcmod(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.mod <keyword:text>', '查询 MCMOD 百科')
    .option('type', '-t <type:string> 资源类型')
    .option('version', '-v <version:string> 支持版本')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'

      try {
        // 搜索并过滤
        let projects = await searchMcmodProjects(ctx, keyword, { type: options.type })

        if (options.version && projects.length) {
          projects = projects.filter(p => !p.mcversion || p.mcversion.includes(options.version))
        }

        if (!projects.length) return '未找到匹配的资源'

        // 转换格式
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
        return '查询时出错'
      }
    })
}
