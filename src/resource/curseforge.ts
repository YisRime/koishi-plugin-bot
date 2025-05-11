import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

const CF_API_BASE = 'https://api.curseforge.com/v1'

// 常量映射表
const CF_MAPS = {
  // 资源类型映射
  TYPE: {
    'mod': 6, 'resourcepack': 12, 'world': 17, 'plugin': 5,
    'modpack': 4471, 'addon': 4559, 'customization': 4546,
    'shader': 6552, 'datapack': 6945
  },

  // 加载器映射
  LOADER: {
    'any': 0, 'forge': 1, 'cauldron': 2, 'liteloader': 3,
    'fabric': 4, 'quilt': 5, 'neoforge': 6
  },

  // 状态映射
  STATUS: {
    1: '新项目', 2: '变更中', 3: '已发布', 4: '已批准', 5: '拒绝', 6: '已删除'
  },

  // 发布类型映射
  RELEASE: {
    1: '正式版', 2: '测试版', 3: '开发版'
  },

  // 依赖关系映射
  RELATION: {
    1: '必需', 2: '可选', 3: '不兼容', 4: '内嵌', 5: '工具'
  }
}

// 搜索CurseForge资源
export async function searchCurseForgeProjects(ctx: Context, keyword: string, api: string, options = {}) {
  try {
    if (!api) return []

    // 基本参数
    const params = {
      gameId: 432,  // Minecraft
      searchFilter: keyword,
      sortField: options['sortField'] || 'popularity',
      sortOrder: options['sortOrder'] || 'desc',
      pageSize: options['pageSize'] || 20,
      index: options['index'] || 0,
    }

    // 添加其他有效参数
    const validParams = [
      'categoryId', 'classId', 'gameVersion', 'modLoaderType',
      'gameVersionTypeId', 'authorId', 'primaryAuthorId', 'slug',
      'categoryIds', 'gameVersions', 'modLoaderTypes'
    ]

    validParams.forEach(param => {
      if (options[param] !== undefined) {
        // 处理数组参数
        if (Array.isArray(options[param])) {
          params[param] = options[param].join(',')
        }
        // 处理字符串数组
        else if (typeof options[param] === 'string' &&
                (param === 'categoryIds' || param === 'gameVersions' || param === 'modLoaderTypes')) {
          try {
            const parsed = JSON.parse(options[param])
            params[param] = Array.isArray(parsed) ? parsed.join(',') : options[param]
          } catch {
            // 如果解析失败，尝试以逗号分隔
            params[param] = options[param]
          }
        } else {
          params[param] = options[param]
        }
      }
    })

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
    if (!api) return null

    // 移除并行获取，只获取项目信息
    const projectRes = await ctx.http.get(`${CF_API_BASE}/mods/${projectId}`, {
      headers: { 'x-api-key': api }
    })

    const project = projectRes.data
    if (!project) return null

    const url = project.links?.websiteUrl || ''
    const formatDate = date => new Date(date).toLocaleString()

    // 构建内容块
    const contentBlocks = []

    // 添加标题
    contentBlocks.push(`【${project.name}】`)

    // 添加Logo
    if (project.logo?.url) {
      contentBlocks.push(h.image(project.logo.url))
    }

    // 摘要
    if (project.summary) {
      contentBlocks.push(project.summary)
    }

    // 基本信息
    contentBlocks.push([
      `状态: ${CF_MAPS.STATUS[project.status] || '未知'}`,
      `作者: ${project.authors.map(a => a.name).join(', ')}`,
      `下载量: ${project.downloadCount.toLocaleString()}`,
      `创建时间: ${formatDate(project.dateCreated)}`,
      `发布时间: ${formatDate(project.dateReleased)}`,
      `最后更新: ${formatDate(project.dateModified)}`,
      `游戏版本: ${project.latestFilesIndexes?.map(f => f.gameVersion).filter((v, i, a) => a.indexOf(v) === i).join(', ') || '未知'}`,
      `模组加载器: ${project.latestFilesIndexes?.map(f => CF_MAPS.LOADER[f.modLoader] || f.modLoader || '未知').filter((v, i, a) => a.indexOf(v) === i).join(', ') || '未知'}`,
      `分类: ${project.categories?.map(c => c.name).join(', ') || '未知'}`,
      project.gamePopularityRank ? `人气排名: #${project.gamePopularityRank}` : null,
      project.thumbsUpCount ? `点赞数: ${project.thumbsUpCount}` : null,
      project.rating ? `评分: ${project.rating.toFixed(1)}` : null
    ].filter(Boolean).map(item => `● ${item}`).join('\n'))

    // 相关链接
    const links = [
      project.links?.websiteUrl && `官方网站: ${project.links.websiteUrl}`,
      project.links?.wikiUrl && `Wiki: ${project.links.wikiUrl}`,
      project.links?.issuesUrl && `问题追踪: ${project.links.issuesUrl}`,
      project.links?.sourceUrl && `源代码: ${project.links.sourceUrl}`
    ].filter(Boolean);

    if (links.length > 0) {
      contentBlocks.push(`◆ 相关链接 ◆\n${links.join('\n')}`)
    }

    // 截图部分
    if (project.screenshots?.length) {
      contentBlocks.push('◆ 截图 ◆')
      project.screenshots.slice(0, 3).forEach(s => {
        contentBlocks.push(`${s.title || '截图'}:`)
        contentBlocks.push(h.image(s.url))
      })
    }

    // 项目页面链接
    contentBlocks.push(`访问完整项目页面: ${url}`)

    return {
      content: contentBlocks,
      url
    }
  } catch (error) {
    ctx.logger.error('CurseForge 资源详情获取失败:', error)
    return null
  }
}

// 注册 curseforge 命令
export function registerCurseForge(ctx: Context, mc: Command, config: Config) {
  // 支持的类型列表，用于帮助信息
  const typeOptions = Object.keys(CF_MAPS.TYPE).join('|')

  mc.subcommand('.curseforge <keyword:text>', `查询 CurseForge 资源(${typeOptions})`)
    .option('type', `-t <type:string> 资源类型(${typeOptions})`)
    .option('version', '-v <version:string> 游戏版本')
    .option('loader', '-l <loader:string> 模组加载器')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'
      if (!config.curseforgeEnabled) return '未配置 CurseForge API 密钥'

      try {
        // 转换选项为API参数
        const searchOptions = {
          categoryId: options.type ? CF_MAPS.TYPE[options.type] : undefined,
          gameVersion: options.version,
          modLoaderType: options.loader ? CF_MAPS.LOADER[options.loader] : undefined
        }

        const projects = await searchCurseForgeProjects(
          ctx, keyword, config.curseforgeEnabled, searchOptions
        )
        if (!projects.length) return '未找到匹配的资源'

        const projectInfo = await getCurseForgeProject(
          ctx, projects[0].id, config.curseforgeEnabled
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
