import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

// CurseForge API 的基本URL
const CF_API_BASE = 'https://api.curseforge.com/v1'

// 搜索 CurseForge 资源列表
export async function searchCurseForgeProjects(ctx: Context, keyword: string, api: string, options = {}) {
  try {
    // 构建搜索参数
    const params: any = {
      gameId: 432,  // 432 是 Minecraft
      searchFilter: keyword,
      sortField: options['sortField'] || 'popularity',
      sortOrder: 'desc'
    }

    // 添加分类过滤
    if (options['categoryId']) params.categoryId = options['categoryId']
    if (options['gameVersion']) params.gameVersion = options['gameVersion']
    if (options['modLoaderType']) params.modLoaderType = options['modLoaderType']

    const response = await ctx.http.get(`${CF_API_BASE}/mods/search`, {
      headers: { 'x-api-key': api },
      params
    })

    return response.data || []
  } catch (error) {
    ctx.logger.error('CurseForge 资源搜索失败:', error)
    return []
  }
}

// 获取 CurseForge 资源详细信息并格式化
export async function getCurseForgeProject(ctx: Context, projectId: number, api: string) {
  try {
    const response = await ctx.http.get(`${CF_API_BASE}/mods/${projectId}`, {
      headers: { 'x-api-key': api }
    })

    const project = response.data
    if (!project) return null

    // 获取最近文件
    let files = []
    try {
      const fileResponse = await ctx.http.get(`${CF_API_BASE}/mods/${projectId}/files`, {
        headers: { 'x-api-key': api },
        params: { pageSize: 3 }
      })
      files = fileResponse.data || []
    } catch (e) {
      ctx.logger.error('CurseForge 文件信息获取失败:', e)
    }

    let content = `
# ${project.name}

${project.summary}

- 作者: ${project.authors.map(a => a.name).join(', ')}
- 下载量: ${project.downloadCount.toLocaleString()}
- 创建时间: ${new Date(project.dateCreated).toLocaleString()}
- 最后更新: ${new Date(project.dateModified).toLocaleString()}
- 游戏版本: ${project.latestFilesIndexes?.map(f => f.gameVersion).join(', ') || '未知'}
- 分类: ${project.categories?.map(c => c.name).join(', ') || '未知'}`

    // 添加最近文件
    if (files.length > 0) {
      content += `\n\n## 最近文件\n`
      files.forEach(file => {
        const date = new Date(file.fileDate).toLocaleDateString()
        const versions = file.gameVersions?.join(', ') || '未知'
        content += `- ${file.fileName} (${date}) - ${versions}\n`
      })
    }

    // 添加模组加载器信息
    const loaders = project.latestFilesIndexes?.map(f => f.modLoader).filter(Boolean)
    if (loaders?.length) {
      const loaderNames = {
        'forge': 'Forge',
        'fabric': 'Fabric',
        'quilt': 'Quilt',
        'neoforge': 'NeoForge'
      }

      content += `\n支持的加载器: ${loaders.map(l => loaderNames[l] || l).join(', ')}`
    }

    content += `\n\n[资源页面](${project.links?.websiteUrl || ''})`
    return content.trim()
  } catch (error) {
    ctx.logger.error('CurseForge 资源详情获取失败:', error)
    return null
  }
}

// 注册 curseforge 命令
export function registerCurseForge(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.curseforge <keyword:text>', '查询 CurseForge 资源')
    .option('type', '-t <type:string> 资源类型(mod/resourcepack/world)')
    .option('version', '-v <version:string> 游戏版本(如1.20.1)')
    .option('loader', '-l <loader:string> 模组加载器(forge/fabric/quilt)')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'
      if (!config.curseforgeApiKey) return '未配置 CurseForge API 密钥'

      try {
        // 构造搜索选项
        const searchOptions: any = {}

        // 添加分类过滤
        if (options.type) {
          const categoryIds = {
            'mod': 6, // Mods
            'resourcepack': 12, // Resource Packs
            'world': 17 // Worlds
          }
          searchOptions.categoryId = categoryIds[options.type]
        }

        // 添加游戏版本过滤
        if (options.version) searchOptions.gameVersion = options.version

        // 添加模组加载器过滤
        if (options.loader) {
          const loaderTypes = {
            'forge': 1,
            'fabric': 4,
            'quilt': 5
          }
          searchOptions.modLoaderType = loaderTypes[options.loader]
        }

        // 搜索资源
        const projects = await searchCurseForgeProjects(ctx, keyword, config.curseforgeApiKey, searchOptions)
        if (projects.length === 0) return '未找到匹配的资源'

        // 显示第一个结果
        const project = await getCurseForgeProject(ctx, projects[0].id, config.curseforgeApiKey)
        if (!project) return '获取资源详情失败'

        return renderOutput(session, project, config.outputMode, ctx)
      } catch (error) {
        ctx.logger.error('[CurseForge] 执行查询命令失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
