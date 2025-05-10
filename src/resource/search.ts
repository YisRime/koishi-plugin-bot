import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { searchModrinthProjects, getModrinthProject } from './modrinth'
import { searchCurseForgeProjects, getCurseForgeProject } from './curseforge'
import { searchMcmodProjects, getMcmodProject } from './mcmod'
import { searchMcwikiPages, getMcwikiPage } from './mcwiki'

// 简化的搜索结果接口
interface SearchResult {
  platform: string
  name: string
  description: string
  url: string
  extra: any
}

// 平台配置 - 使用更紧凑的结构
const PLATFORMS = {
  modrinth: {
    name: 'Modrinth',
    search: searchModrinthProjects,
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
    search: (ctx, keyword, config) => searchCurseForgeProjects(ctx, keyword, config.curseforgeApiKey),
    getDetail: (ctx, id, config) => getCurseForgeProject(ctx, id, config.curseforgeApiKey),
    transform: p => ({
      platform: 'CurseForge',
      name: p.name,
      description: p.summary,
      url: p.links?.websiteUrl || '',
      extra: { id: p.id, author: p.authors.map(a => a.name).join(', '), downloads: p.downloadCount }
    }),
    checkConfig: config => config.curseforgeEnabled && config.curseforgeApiKey
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

// 格式化用于用户选择的搜索结果
function formatSearchResultsForSelection(results: SearchResult[]) {
  if (!results?.length) return '未找到匹配的资源'

  return ['找到以下资源，请回复数字选择一个查看详情：\n',
    ...results.map((p, i) =>
      `${i + 1}. [${p.platform}] ${p.name}\n   ${p.description?.substring(0, 50)}${p.description?.length > 50 ? '...' : ''}`
    ),
    '\n回复数字查看详情，或回复"取消"退出'
  ].join('\n')
}

// 注册统一的搜索命令
export function registerSearch(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.search <keyword:text>', '搜索 Minecraft 资源')
    .option('platform', '-p <platform:string>')
    .option('sort', '-s <sort:string> 排序方式(downloads/name/date)')
    .option('limit', '-l <limit:number> 结果数量限制')
    .option('shot', '--shot 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        // 搜索各平台资源
        const platformsToSearch = options.platform === 'all' || !options.platform
          ? Object.keys(PLATFORMS) : [options.platform]
        let results: SearchResult[] = []

        for (const p of platformsToSearch) {
          const platform = PLATFORMS[p]
          if (!platform) continue

          if (platform.checkConfig(config)) {
            const projects = await platform.search(ctx, keyword, config)
            if (projects?.length) results.push(...projects.map(platform.transform))
          } else if (options.platform === p) {
            return `${platform.name} 搜索未启用或配置不完整`
          }
        }

        if (results.length === 0) return '未找到匹配的资源'

        // 排序和限制结果
        if (options.sort) {
          const sortField = options.sort === 'name' ? 'name' : 'downloads'
          results.sort((a, b) =>
            sortField === 'name'
              ? a.name.localeCompare(b.name)
              : (b.extra[sortField] || 0) - (a.extra[sortField] || 0))
        }

        results = results.slice(0, options.limit > 0 ? options.limit : 10)

        // 用户选择流程
        await session.send(formatSearchResultsForSelection(results))
        const response = await session.prompt(60 * 1000)

        if (!response || response.toLowerCase() === '取消') return '已取消查询'

        const choice = parseInt(response)
        if (isNaN(choice) || choice < 1 || choice > results.length) {
          return `请输入1-${results.length}之间的数字`
        }

        // 获取详细信息
        const selected = results[choice - 1]
        const platform = Object.values(PLATFORMS).find(p => p.name === selected.platform)
        if (!platform) return '无法处理所选平台资源'

        const idField = selected.platform === 'MCMOD' ? selected : selected.extra.id
        const detail = await platform.getDetail(ctx, idField, config)

        if (!detail) return '获取详细信息失败'

        // 渲染输出
        const result = await renderOutput(session, detail.content, detail.url, ctx, config, options.shot)
        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('执行搜索命令失败:', error)
        return '搜索时发生错误，请稍后再试'
      }
    })
}
