import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

// Modrinth API 的基本URL
const MR_API_BASE = 'https://api.modrinth.com/v2'

// 搜索 Modrinth 资源列表
export async function searchModrinthProjects(ctx: Context, keyword: string, options = {}) {
  try {
    // 构建搜索参数
    const params: any = { query: keyword }

    // 添加可选的过滤条件
    if (options['categories']) params.categories = options['categories']
    if (options['versions']) params.versions = options['versions']
    if (options['limit']) params.limit = options['limit']

    const response = await ctx.http.get(`${MR_API_BASE}/search`, { params })
    return response.hits || []
  } catch (error) {
    ctx.logger.error('Modrinth 资源搜索失败:', error)
    return []
  }
}

// 获取 Modrinth 资源详细信息并格式化
export async function getModrinthProject(ctx: Context, projectId: string) {
  try {
    const project = await ctx.http.get(`${MR_API_BASE}/project/${projectId}`)
    if (!project) return null

    // 获取资源版本信息
    let versions = []
    try {
      versions = await ctx.http.get(`${MR_API_BASE}/project/${projectId}/version`)
      versions = versions.slice(0, 3) // 只展示最近的3个版本
    } catch (e) {
      ctx.logger.error('Modrinth 版本信息获取失败:', e)
    }

    // 获取资源依赖信息
    let dependencies = []
    if (versions.length > 0) {
      try {
        const deps = versions[0].dependencies || []
        dependencies = deps.filter(d => d.dependency_type === 'required').map(d => d.project_id)
      } catch (e) {
        ctx.logger.error('解析Modrinth资源依赖时出错:', e)
      }
    }

    let content = `
# ${project.title}

${project.description}

- 作者: ${project.author}
- 下载量: ${project.downloads.toLocaleString()}
- 创建时间: ${new Date(project.published).toLocaleString()}
- 最后更新: ${new Date(project.updated).toLocaleString()}
- 游戏版本: ${project.game_versions?.join(', ') || '未知'}
- 分类: ${project.categories?.join(', ') || '未知'}
- 许可证: ${project.license?.id || '未知'}
`

    // 添加版本信息
    if (versions.length > 0) {
      content += `\n## 最近版本\n`
      versions.forEach(v => {
        content += `- ${v.version_number} (${new Date(v.date_published).toLocaleDateString()}) - ${v.name}\n`
      })
    }

    // 添加依赖信息
    if (dependencies.length > 0) {
      content += `\n## 依赖项\n`
      content += `此资源依赖 ${dependencies.length} 个其他模组\n`
    }

    content += `\n[资源页面](https://modrinth.com/${project.project_type}/${project.slug})`
    return content.trim()
  } catch (error) {
    ctx.logger.error('Modrinth 资源详情获取失败:', error)
    return null
  }
}

// 注册 modrinth 命令
export function registerModrinth(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.modrinth <keyword:text>', '查询 Modrinth 资源')
    .option('type', '-t <type:string> 资源类型(mod/plugin/resourcepack/datapack)')
    .option('version', '-v <version:string> 游戏版本')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        // 构造搜索选项
        const searchOptions: any = {}
        if (options.type) {
          const typeMap = {
            'mod': 'mod',
            'plugin': 'plugin',
            'resourcepack': 'resourcepack',
            'datapack': 'datapack'
          }
          searchOptions.categories = typeMap[options.type]
        }
        if (options.version) searchOptions.versions = options.version

        // 搜索资源
        const projects = await searchModrinthProjects(ctx, keyword, searchOptions)
        if (projects.length === 0) return '未找到匹配的资源'

        // 显示第一个结果
        const project = await getModrinthProject(ctx, projects[0].project_id)
        if (!project) return '获取资源详情失败'

        return renderOutput(session, project, config.outputMode, ctx)
      } catch (error) {
        ctx.logger.error('Modrinth 查询失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
