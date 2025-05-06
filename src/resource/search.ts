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
  extra: any // 存储平台特有的额外信息
}

// 格式化搜索结果
function formatSearchResults(results: SearchResult[], platform: string) {
  if (!results || results.length === 0) return `未找到匹配的${platform}资源`

  let result = `# ${platform} 搜索结果\n\n`

  // 按平台分组结果
  if (platform === '全平台') {
    const byPlatform = results.reduce((acc, item) => {
      acc[item.platform] = acc[item.platform] || []
      acc[item.platform].push(item)
      return acc
    }, {})

    // 按平台顺序展示
    const platformOrder = ['Modrinth', 'CurseForge', 'MCMOD', 'Minecraft Wiki']
    platformOrder.forEach(p => {
      if (byPlatform[p] && byPlatform[p].length > 0) {
        result += `## ${p}\n\n`
        byPlatform[p].slice(0, 3).forEach((project, idx) => {
          formatItem(result, project, idx)
        })
        result += '\n'
      }
    })
  } else {
    // 单平台展示
    results.forEach((project, index) => {
      formatItem(result, project, index)
    })
  }

  return result.trim()
}

function formatItem(result, project, index) {
  result += `${index + 1}. **${project.name}**\n`
  result += `   ${project.description.substring(0, 100)}${project.description.length > 100 ? '...' : ''}\n`

  // 根据平台添加特定信息
  switch(project.platform) {
    case 'Modrinth':
      result += `   类型: ${project.extra.type || '未知'} | 下载量: ${project.extra.downloads?.toLocaleString() || '0'} | 作者: ${project.extra.author || '未知'}\n`
      break
    case 'CurseForge':
      result += `   下载量: ${project.extra.downloads?.toLocaleString() || '0'} | 作者: ${project.extra.author || '未知'}\n`
      break
    case 'MCMOD':
      result += `   类型: ${project.extra.type || '未知'} | 游戏版本: ${project.extra.mcversion || '未知'}\n`
      break
    case 'Minecraft Wiki':
      // Wiki 页面不需要额外信息
      break
    default:
      result += `   平台: ${project.platform}\n`
  }

  result += `   ${project.url}\n\n`
}

// 注册统一的搜索命令
export function registerSearch(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.search <keyword:text>', '搜索 Minecraft 资源')
    .option('platform', '-p <platform:string>')
    .option('sort', '-s <sort:string> 排序方式(downloads/name/date)')
    .option('limit', '-l <limit:number> 结果数量限制')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      const platform = options.platform || 'all'
      let results: SearchResult[] = []

      try {
        // 搜索 Modrinth
        if ((platform === 'modrinth' || platform === 'all') && config.modrinthEnabled) {
          const projects = await searchModrinthProjects(ctx, keyword)
          if (projects.length > 0) {
            results = [...results, ...projects.map(p => ({
              platform: 'Modrinth',
              name: p.title,
              description: p.description,
              url: `https://modrinth.com/${p.project_type}/${p.slug}`,
              extra: {
                id: p.project_id,
                type: p.project_type,
                author: p.author,
                downloads: p.downloads
              }
            }))]
          }
        } else if (platform === 'modrinth' && !config.modrinthEnabled) {
          return 'Modrinth 搜索未启用'
        }

        // 搜索 CurseForge
        if ((platform === 'curseforge' || platform === 'all') && config.curseforgeEnabled && config.curseforgeApiKey) {
          const projects = await searchCurseForgeProjects(ctx, keyword, config.curseforgeApiKey)
          if (projects.length > 0) {
            results = [...results, ...projects.map(p => ({
              platform: 'CurseForge',
              name: p.name,
              description: p.summary,
              url: p.links?.websiteUrl || '',
              extra: {
                id: p.id,
                author: p.authors.map(a => a.name).join(', '),
                downloads: p.downloadCount
              }
            }))]
          }
        } else if (platform === 'curseforge' && (!config.curseforgeEnabled || !config.curseforgeApiKey)) {
          return 'CurseForge 搜索未启用或未配置 API 密钥'
        }

        // 搜索 MCMOD
        if ((platform === 'mcmod' || platform === 'all') && config.mcmodEnabled) {
          const projects = await searchMcmodProjects(ctx, keyword)
          if (projects.length > 0) {
            results = [...results, ...projects.map(p => ({
              platform: 'MCMOD',
              name: p.name,
              description: p.description || '暂无描述',
              url: `https://www.mcmod.cn/item/${p.id}.html`,
              extra: {
                id: p.id,
                type: p.type,
                mcversion: p.mcversion
              }
            }))]
          }
        } else if (platform === 'mcmod' && !config.mcmodEnabled) {
          return 'MCMOD 搜索未启用'
        }

        // 搜索 Minecraft Wiki
        if ((platform === 'mcwiki' || platform === 'all') && config.mcwikiEnabled) {
          const pages = await searchMcwikiPages(ctx, keyword)
          if (pages.length > 0) {
            results = [...results, ...pages.map(p => {
              // 移除HTML标签
              const cleanSnippet = p.snippet.replace(/<\/?[^>]+(>|$)/g, '')

              return {
                platform: 'Minecraft Wiki',
                name: p.title,
                description: cleanSnippet,
                url: `https://minecraft.fandom.com/zh/wiki/${encodeURIComponent(p.title)}`,
                extra: {
                  id: p.pageid
                }
              }
            })]
          }
        } else if (platform === 'mcwiki' && !config.mcwikiEnabled) {
          return 'Minecraft Wiki 搜索未启用'
        }

        if (results.length === 0) {
          return '未找到匹配的资源'
        }

        // 排序结果
        if (options.sort) {
          switch(options.sort) {
            case 'downloads':
              results.sort((a, b) => (b.extra.downloads || 0) - (a.extra.downloads || 0))
              break
            case 'name':
              results.sort((a, b) => a.name.localeCompare(b.name))
              break
            case 'date':
              // 默认已经是按日期/相关性排序
              break
          }
        }

        // 限制结果数量
        if (options.limit && !isNaN(options.limit) && options.limit > 0) {
          results = results.slice(0, options.limit)
        }

        // 整合并格式化结果
        const platformName = {
          'modrinth': 'Modrinth',
          'curseforge': 'CurseForge',
          'mcmod': 'MCMOD',
          'mcwiki': 'Minecraft Wiki',
          'all': '全平台'
        }[platform] || platform

        const content = formatSearchResults(results, platformName)
        return renderOutput(session, content, config.outputMode, ctx)
      } catch (error) {
        ctx.logger.error('执行搜索命令失败:', error)
        return '搜索时发生错误，请稍后再试'
      }
    })
}
