import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

const MR_API_BASE = 'https://api.modrinth.com/v2'

// 搜索Modrinth资源
export async function searchModrinthProjects(ctx: Context, keyword: string, options = {}) {
  try {
    const params = { query: keyword, ...Object.fromEntries(Object.entries(options).filter(([_, v]) => v !== undefined)) }
    const response = await ctx.http.get(`${MR_API_BASE}/search`, { params })
    return response.hits || []
  } catch (error) {
    ctx.logger.error('Modrinth 资源搜索失败:', error)
    return []
  }
}

// 获取Modrinth资源详情
export async function getModrinthProject(ctx: Context, projectId: string) {
  try {
    // 并行获取项目信息和版本信息
    const [project, allVersions] = await Promise.all([
      ctx.http.get(`${MR_API_BASE}/project/${projectId}`),
      ctx.http.get(`${MR_API_BASE}/project/${projectId}/version`).catch(() => [])
    ])

    if (!project) return null

    const versions = allVersions.slice(0, 3)
    const projectUrl = `https://modrinth.com/${project.project_type}/${project.slug}`

    // 构建内容
    let content = `# ${project.title}\n\n${project.description}\n\n` +
      [
        `作者: ${project.author}`,
        `下载量: ${project.downloads.toLocaleString()}`,
        `创建时间: ${new Date(project.published).toLocaleString()}`,
        `更新时间: ${new Date(project.updated).toLocaleString()}`,
        `游戏版本: ${project.game_versions?.join(', ') || '未知'}`,
        `分类: ${project.categories?.join(', ') || '未知'}`,
        `许可证: ${project.license?.id || '未知'}`
      ].map(item => `- ${item}`).join('\n')

    // 添加版本信息
    if (versions.length > 0) {
      content += `\n\n## 最近版本\n${versions.map(v =>
        `- ${v.version_number} (${new Date(v.date_published).toLocaleDateString()}) - ${v.name}`
      ).join('\n')}`
    }

    content += `\n\n[资源页面](${projectUrl})`
    return { content: content.trim(), url: projectUrl }
  } catch (error) {
    ctx.logger.error('Modrinth 资源详情获取失败:', error)
    return null
  }
}

// 注册 modrinth 命令
export function registerModrinth(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.modrinth <keyword:text>', '查询 Modrinth 资源')
    .option('type', '-t <type:string> 资源类型')
    .option('version', '-v <version:string> 游戏版本')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const projects = await searchModrinthProjects(ctx, keyword, {
          categories: options.type,
          versions: options.version
        })
        if (!projects.length) return '未找到匹配的资源'

        const projectInfo = await getModrinthProject(ctx, projects[0].project_id)
        if (!projectInfo) return '获取资源详情失败'

        const result = await renderOutput(
          session, projectInfo.content, projectInfo.url, ctx, config, options.shot
        )

        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('Modrinth 查询失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
