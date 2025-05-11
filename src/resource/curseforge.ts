import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

/** CurseForge API基础URL */
const CF_API_BASE = 'https://api.curseforge.com/v1'

/**
 * CurseForge相关映射表
 * @type {Object}
 */
const CF_MAPS = {
  /** 资源类型映射 */
  TYPE: {
    'mod': 6, 'resourcepack': 12, 'world': 17, 'plugin': 5,
    'modpack': 4471, 'addon': 4559, 'customization': 4546,
    'shader': 6552, 'datapack': 6945
  },
  /** 加载器类型映射 */
  LOADER: {
    'any': 0, 'forge': 1, 'cauldron': 2, 'liteloader': 3,
    'fabric': 4, 'quilt': 5, 'neoforge': 6
  },
  /** 发布类型映射 */
  RELEASE: { 1: '正式版', 2: '快照版', 3: '开发版' },
  /** 依赖关系映射 */
  RELATION: { 1: '必需', 2: '可选', 3: '不兼容', 4: '内置', 5: '工具' }
}

/**
 * 搜索CurseForge项目
 * @param {Context} ctx - Koishi上下文
 * @param {string} keyword - 搜索关键词
 * @param {string} api - API密钥
 * @param {Object} options - 搜索选项
 * @returns {Promise<Array>} 搜索结果
 */
export async function searchCurseForgeProjects(ctx: Context, keyword: string, api: string, options = {}) {
  try {
    if (!api) return []
    const params = { gameId: 432, searchFilter: keyword }
    // 处理搜索参数
    const validParams = [
      'categoryId', 'classId', 'gameVersion', 'modLoaderType',
      'gameVersionTypeId', 'authorId', 'primaryAuthorId', 'slug',
      'categoryIds', 'gameVersions', 'modLoaderTypes',
      'sortField', 'sortOrder', 'pageSize', 'index'
    ]
    validParams.forEach(param => {
      if (options[param] === undefined) return
      if (Array.isArray(options[param])) {
        params[param] = options[param].join(',')
      } else if (typeof options[param] === 'string' &&
        (param === 'categoryIds' || param === 'gameVersions' || param === 'modLoaderTypes')) {
        try {
          const parsed = JSON.parse(options[param])
          params[param] = Array.isArray(parsed) ? parsed.join(',') : options[param]
        } catch {
          params[param] = options[param]
        }
      } else {
        params[param] = options[param]
      }
    })
    const response = await ctx.http.get(`${CF_API_BASE}/mods/search`, { headers: { 'x-api-key': api }, params })
    return response.data || []
  } catch (error) {
    ctx.logger.error('CurseForge 搜索失败:', error)
    return []
  }
}

/**
 * 获取CurseForge项目详情
 * @param {Context} ctx - Koishi上下文
 * @param {number} projectId - 项目ID
 * @param {string} api - API密钥
 * @returns {Promise<Object|null>} 项目详情，包含content和url
 */
export async function getCurseForgeProject(ctx: Context, projectId: number, api: string) {
  try {
    if (!api) return null
    const projectRes = await ctx.http.get(`${CF_API_BASE}/mods/${projectId}`, { headers: { 'x-api-key': api } })
    const project = projectRes.data
    if (!project) return null
    const formatDate = date => new Date(date).toLocaleString()
    // 构建内容
    const content = [
      project.logo.url && h.image(project.logo.url),
      `[${project.name}]\n${project.summary}`,
      // 基本信息
      [
        `分类: ${project.categories?.map(c => c.name).join(', ')}`,
        `加载器: ${project.latestFilesIndexes?.map(f => { return Object.entries(CF_MAPS.LOADER)
            .find(([_, val]) => val === f.modLoader)?.[0] || f.modLoader;
        }).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
        `支持版本: ${project.latestFilesIndexes?.map(f => f.gameVersion)
          .filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
        `作者: ${project.authors.map(a => a.name).join(', ')}`,
        `更新于: ${formatDate(project.dateModified)}`,
        `下载量: ${project.downloadCount.toLocaleString()}`
      ].filter(Boolean).map(item => `● ${item}`).join('\n'),
    ].filter(Boolean)
    // 相关链接
    const links = [
      project.links?.websiteUrl && `官方网站: ${project.links.websiteUrl}`,
      project.links?.wikiUrl && `Wiki: ${project.links.wikiUrl}`,
      project.links?.issuesUrl && `问题追踪: ${project.links.issuesUrl}`,
      project.links?.sourceUrl && `源代码: ${project.links.sourceUrl}`
    ].filter(Boolean)
    if (links.length > 0) content.push(`相关链接：\n${links.join('\n')}`)
    // 图库
    if (project.screenshots?.length) {
      content.push('图库：')
      project.screenshots.slice(0, 3).forEach(s => {content.push(h.image(s.url))})
    }
    // 项目地址
    content.push(`项目地址：${project.links.websiteUrl}`)
    return { content, url: project.links.websiteUrl }
  } catch (error) {
    ctx.logger.error('CurseForge 详情获取失败:', error)
    return null
  }
}

/**
 * 注册CurseForge命令
 * @param {Context} ctx - Koishi上下文
 * @param {Command} mc - 父命令对象
 * @param {Config} config - 配置对象
 */
export function registerCurseForge(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.curseforge <keyword:text>', `查询 CurseForge 资源`)
    .option('type', `-t <type:string> 资源类型(${Object.keys(CF_MAPS.TYPE).join('|')})`)
    .option('version', '-v <version:string> 支持版本')
    .option('loader', '-l <loader:string> 加载器')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      if (!config.curseforgeEnabled) return '未配置 CurseForge API 密钥'
      try {
        const searchOptions = {
          categoryId: options.type ? CF_MAPS.TYPE[options.type] : undefined,
          gameVersion: options.version,
          modLoaderType: options.loader ? CF_MAPS.LOADER[options.loader] : undefined
        }
        const projects = await searchCurseForgeProjects(ctx, keyword, config.curseforgeEnabled, searchOptions)
        if (!projects.length) return '未找到匹配的资源'
        const projectInfo = await getCurseForgeProject(ctx, projects[0].id, config.curseforgeEnabled)
        if (!projectInfo) return '获取详情失败'
        const result = await renderOutput(session, projectInfo.content, projectInfo.url, ctx, config, options.shot)
        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('CurseForge 查询失败:', error)
        return '查询时出错'
      }
    })
}