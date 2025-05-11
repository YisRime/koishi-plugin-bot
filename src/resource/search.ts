import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { searchModrinthProjects, getModrinthProject } from './modrinth'
import { searchCurseForgeProjects, getCurseForgeProject } from './curseforge'
import { searchMcmodProjects, getMcmodProject } from './mcmod'
import { searchMcwikiPages, getMcwikiPage } from './mcwiki'

interface SearchResult {
  platform: string
  name: string
  description: string
  url: string
  extra: any
}

// 简化平台配置
const PLATFORMS = {
  modrinth: {
    name: 'Modrinth',
    search: (ctx, keyword, config, options = {}) => searchModrinthProjects(ctx, keyword, {
      ...options,
      limit: config.searchResults
    }),
    getDetail: getModrinthProject,
    transform: p => ({
      platform: 'Modrinth',
      name: p.title,
      description: p.description,
      url: `https://modrinth.com/${p.project_type}/${p.slug}`,
      extra: { id: p.project_id, type: p.project_type, author: p.author, downloads: p.downloads }
    }),
    checkConfig: config => config.modrinthEnabled
  },
  curseforge: {
    name: 'CurseForge',
    search: (ctx, keyword, config, options = {}) => searchCurseForgeProjects(ctx, keyword, config.curseforgeEnabled, options),
    getDetail: (ctx, id, config) => getCurseForgeProject(ctx, id, config.curseforgeEnabled),
    transform: p => ({
      platform: 'CurseForge',
      name: p.name,
      description: p.summary,
      url: p.links?.websiteUrl || '',
      extra: {
        id: p.id,
        author: p.authors.map(a => a.name).join(', '),
        downloads: p.downloadCount,
        type: p.classId  // 添加类型ID便于过滤
      }
    }),
    checkConfig: config => config.curseforgeEnabled
  },
  mcmod: {
    name: 'MCMOD',
    search: searchMcmodProjects,
    getDetail: getMcmodProject,
    transform: p => ({
      platform: 'MCMOD',
      name: p.name,
      description: p.description || '暂无描述',
      url: `https://www.mcmod.cn/item/${p.id}.html`,
      extra: { id: p.id, type: p.type, mcversion: p.mcversion }
    }),
    checkConfig: config => config.mcmodEnabled
  },
  mcwiki: {
    name: 'Minecraft Wiki',
    search: searchMcwikiPages,
    getDetail: getMcwikiPage,
    transform: p => ({
      platform: 'Minecraft Wiki',
      name: p.title,
      description: p.snippet.replace(/<\/?[^>]+(>|$)/g, ''),
      url: `https://minecraft.fandom.com/zh/wiki/${encodeURIComponent(p.title)}`,
      extra: { id: p.pageid }
    }),
    checkConfig: config => config.mcwikiEnabled
  }
}

// 更新格式化搜索结果函数以适应数组形式
function formatSearchResults(results: SearchResult[], descLength: number = 50) {
  if (!results?.length) return ['未找到匹配的资源']

  const contentArray = ['请回复数字选择一个查看详情：']

  // 添加每个结果项
  results.forEach((p, i) => {
    // 根据descLength配置决定是否显示描述及显示多少字符
    const descPart = descLength > 0 && p.description
      ? `\n   ${p.description.substring(0, descLength)}${p.description.length > descLength ? '...' : ''}`
      : '';
    contentArray.push(`${i + 1}. [${p.platform}] ${p.name}${descPart}`);
  })

  return contentArray
}

// 交错排列结果
function interleavePlatformResults(platforms: Record<string, SearchResult[]>, limit: number): SearchResult[] {
  const result = []
  let hasMore = true
  let index = 0

  while (hasMore && result.length < limit) {
    hasMore = false
    for (const platform in platforms) {
      if (index < platforms[platform].length) {
        result.push(platforms[platform][index])
        hasMore = true
        if (result.length >= limit) break
      }
    }
    index++
  }

  return result
}

// 根据选项过滤结果
function filterResultsByOptions(results: SearchResult[], platform: string, options: any) {
  if (!results) return []

  // 版本过滤
  if (options.version && platform === 'mcmod') {
    results = results.filter(item =>
      !item.extra?.mcversion ||
      item.extra.mcversion.includes(options.version)
    )
  }

  // 类型过滤
  if (options.type) {
    if (platform === 'modrinth') {
      const validTypes = ['mod', 'modpack', 'resourcepack', 'shader'];
      if (validTypes.includes(options.type)) {
        results = results.filter(item => item.extra?.type === options.type)
      }
    } else if (platform === 'mcmod') {
      results = results.filter(item =>
        !item.extra?.type ||
        item.extra.type.toLowerCase().includes(options.type.toLowerCase())
      )
    }
  }

  return results
}

export function registerSearch(ctx: Context, mc: Command, config: Config) {
  // CurseForge 分类类型映射
  const cfTypeMap = {
    'mod': 6,              // Mods
    'resourcepack': 12,    // Resource Packs
    'world': 17,           // Worlds
    'plugin': 5,           // Bukkit Plugins
    'modpack': 4471,       // Modpacks
    'addon': 4559,         // Addons
    'customization': 4546, // Customization
    'shader': 6552,        // Shaders
    'datapack': 6945       // Data Packs
  }

  // CurseForge 加载器映射
  const cfLoaderMap = {
    'any': 0,
    'forge': 1,
    'cauldron': 2,
    'liteloader': 3,
    'fabric': 4,
    'quilt': 5,
    'neoforge': 6
  }

  // 支持的类型选项
  const typeOptions = Object.keys(cfTypeMap).join('|')

  mc.subcommand('.search <keyword:text>', '搜索 Minecraft 资源')
    .option('mr', '-mr 搜索Modrinth平台')
    .option('cf', '-cf 搜索CurseForge平台')
    .option('mcmod', '-m 搜索MCMOD百科')
    .option('mcwiki', '-w 搜索MC Wiki')
    .option('all', '-a 搜索所有可用平台')
    .option('shot', '-s 使用截图模式')
    .option('mrs', '-mrs <sort:string> Modrinth排序(relevance/downloads/follows/newest/updated)')
    .option('mrf', '-mrf <facets:string> Modrinth高级过滤')
    .option('cfl', '-cfl <loader:string> CurseForge模组加载器(forge/fabric/quilt)')
    .option('cfs', '-cfs <sort:string> CurseForge排序(popularity/lastupdated/name/downloads)')
    .option('cfo', '-cfo <order:string> CurseForge排序顺序(asc/desc)')
    .option('version', '-v <version:string> 游戏版本过滤(适用于所有平台)')
    .option('type', `-t <type:string> 资源类型(${typeOptions})`)
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        // 确定搜索平台
        const platformsToSearch = options.all ? Object.keys(PLATFORMS) :
          [options.mr && 'modrinth', options.cf && 'curseforge',
           options.mcmod && 'mcmod', options.mcwiki && 'mcwiki']
            .filter(Boolean);

        // 如果未指定任何平台，使用默认
        if (platformsToSearch.length === 0) {
          platformsToSearch.push('modrinth', 'curseforge');
        }

        // 平台参数配置
        const platformOptions = {
          modrinth: {
            facets: options.mrf,
            sort: options.mrs,
            version: options.version,
            ...(options.type && { facets: JSON.stringify([[`project_type:${options.type}`]]) })
          },
          curseforge: {
            categoryId: options.type ? cfTypeMap[options.type] : undefined,
            gameVersion: options.version,
            modLoaderType: options.cfl ? cfLoaderMap[options.cfl] : undefined,
            sortField: options.cfs,
            sortOrder: options.cfo
          },
          mcmod: { type: options.type },
          mcwiki: {}
        }

        // 并行搜索所有平台
        const searchResults = await Promise.all(
          platformsToSearch.map(async p => {
            const platform = PLATFORMS[p]
            if (!platform?.checkConfig(config)) return { platform: p, results: [] }

            try {
              const projects = await platform.search(ctx, keyword, config, platformOptions[p] || {})
              const results = projects.map(platform.transform)
              return {
                platform: p,
                results: filterResultsByOptions(results, p, options)
              }
            } catch (error) {
              ctx.logger.error(`${platform.name} 搜索失败:`, error)
              return { platform: p, results: [] }
            }
          })
        )

        // 整理结果
        const resultsByPlatform = {}
        searchResults.forEach(({ platform, results }) => {
          if (results.length > 0) resultsByPlatform[platform] = results
        })

        // 检查结果
        if (Object.keys(resultsByPlatform).length === 0) {
          const platformNames = platformsToSearch
            .map(p => PLATFORMS[p]?.name || p).join('、')
          return `在${platformNames}中未找到匹配的资源${options.type ? `，类型: ${options.type}` : ''}${options.version ? `，版本: ${options.version}` : ''}`
        }

        // 交错排序并显示
        const combinedResults = interleavePlatformResults(resultsByPlatform, config.searchResults)
        const formattedResults = formatSearchResults(combinedResults, config.searchDesc)
        await renderOutput(session, formattedResults, null, ctx, config, false)

        // 获取用户选择
        const response = await session.prompt(60 * 1000)
        const choice = parseInt(response)

        if (isNaN(choice) || choice < 1 || choice > combinedResults.length) {
          return `请输入1-${combinedResults.length}之间的数字`
        }

        // 获取详情
        const selected = combinedResults[choice - 1]
        const platform = Object.values(PLATFORMS).find(p => p.name === selected.platform)
        const idField = selected.platform === 'MCMOD' ? selected : selected.extra.id
        const detail = await platform?.getDetail(ctx, idField, config)

        if (!detail) return '获取详细信息失败'
        return renderOutput(session, detail.content, detail.url, ctx, config, options.shot)
      } catch (error) {
        ctx.logger.error('执行搜索命令失败:', error)
        return '搜索时发生错误，请稍后再试'
      }
    })
}
