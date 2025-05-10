import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

const CF_API_BASE = 'https://api.curseforge.com/v1'

// 搜索CurseForge资源
export async function searchCurseForgeProjects(ctx: Context, keyword: string, api: string, options = {}) {
  try {
    const params = {
      gameId: 432,  // Minecraft
      searchFilter: keyword,
      sortField: options['sortField'] || 'popularity',
      sortOrder: 'desc',
      ...Object.fromEntries(
        Object.entries(options)
          .filter(([k, v]) => v !== undefined && ['categoryId', 'gameVersion', 'modLoaderType'].includes(k))
      )
    }

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

// 获取CurseForge资源详情
export async function getCurseForgeProject(ctx: Context, projectId: number, api: string) {
  try {
    // 并行获取项目和文件信息
    const [projectRes, fileRes] = await Promise.all([
      ctx.http.get(`${CF_API_BASE}/mods/${projectId}`, {
        headers: { 'x-api-key': api }
      }),
      ctx.http.get(`${CF_API_BASE}/mods/${projectId}/files`, {
        headers: { 'x-api-key': api },
        params: { pageSize: 3 }
      }).catch(() => ({ data: [] }))
    ])

    const project = projectRes.data
    if (!project) return null

    const files = fileRes.data || []
    const url = project.links?.websiteUrl || ''
    const formatDate = date => new Date(date).toLocaleString()

    // 构建内容
    const content = [
      `# ${project.name}`,
      project.summary,
      [
        `作者: ${project.authors.map(a => a.name).join(', ')}`,
        `下载量: ${project.downloadCount.toLocaleString()}`,
        `创建时间: ${formatDate(project.dateCreated)}`,
        `最后更新: ${formatDate(project.dateModified)}`,
        `游戏版本: ${project.latestFilesIndexes?.map(f => f.gameVersion).join(', ') || '未知'}`,
        `分类: ${project.categories?.map(c => c.name).join(', ') || '未知'}`
      ].map(item => `- ${item}`).join('\n'),
      files.length > 0 ?
        `## 最近文件\n${files.map(file =>
          `- ${file.fileName} (${new Date(file.fileDate).toLocaleDateString()}) - ${file.gameVersions?.join(', ') || '未知'}`
        ).join('\n')}` : '',
      `[资源页面](${url})`
    ].filter(Boolean).join('\n\n')

    return { content, url }
  } catch (error) {
    ctx.logger.error('CurseForge 资源详情获取失败:', error)
    return null
  }
}

// 注册 curseforge 命令
export function registerCurseForge(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.curseforge <keyword:text>', '查询 CurseForge 资源')
    .option('type', '-t <type:string> 资源类型')
    .option('version', '-v <version:string> 游戏版本')
    .option('loader', '-l <loader:string> 模组加载器')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'
      if (!config.curseforgeApiKey) return '未配置 CurseForge API 密钥'

      try {
        // 转换选项为API参数
        const typeMap = { 'mod': 6, 'resourcepack': 12, 'world': 17 }
        const loaderMap = { 'forge': 1, 'fabric': 4, 'quilt': 5 }

        const searchOptions = {
          categoryId: options.type ? typeMap[options.type] : undefined,
          gameVersion: options.version,
          modLoaderType: options.loader ? loaderMap[options.loader] : undefined
        }

        const projects = await searchCurseForgeProjects(
          ctx, keyword, config.curseforgeApiKey, searchOptions
        )
        if (!projects.length) return '未找到匹配的资源'

        const projectInfo = await getCurseForgeProject(
          ctx, projects[0].id, config.curseforgeApiKey
        )
        if (!projectInfo) return '获取资源详情失败'

        const result = await renderOutput(
          session, projectInfo.content, projectInfo.url, ctx, config, options.shot
        )

        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('CurseForge 查询失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
