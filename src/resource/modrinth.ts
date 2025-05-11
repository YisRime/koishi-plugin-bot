import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

const MR_API_BASE = 'https://api.modrinth.com/v2'

// 简化状态映射
const STATUS_MAP = {
  project: {
    approved: '已批准', archived: '已归档', rejected: '被拒绝',
    draft: '草稿', unlisted: '未公开', processing: '处理中',
    withheld: '已撤回', scheduled: '已计划', private: '私有'
  },
  compatibility: {
    required: '必需', optional: '可选', unsupported: '不支持'
  },
  monetization: {
    monetized: '已开启', demonetized: '已关闭', 'force-demonetized': '被强制关闭'
  },
  type: {
    mod: '模组', modpack: '整合包', resourcepack: '资源包', shader: '着色器'
  }
}

// 解析 facets 参数
function parseFacets(facetsStr: string): string[][] {
  if (!facetsStr) return []

  try {
    // JSON格式或简化格式处理
    if (facetsStr.startsWith('[') && facetsStr.endsWith(']')) {
      return JSON.parse(facetsStr)
    }

    // 简化格式: "类型:值" 或 "类型:操作:值"
    return facetsStr.split(',').map(facet => {
      const parts = facet.trim().split(':')
      return parts.length >= 2 ?
        [parts.length === 2 ? `${parts[0]}:${parts[1]}` : `${parts[0]}${parts[1]}${parts[2]}`] :
        [facet.trim()]
    })
  } catch {
    return []
  }
}

// 统一格式化函数
function formatValue(type: string, value: string): string {
  return (STATUS_MAP[type] && STATUS_MAP[type][value]) || value || '未知'
}

// 搜索函数
export async function searchModrinthProjects(ctx: Context, keyword: string, options = {}) {
  try {
    const { facets, sort, ...otherOptions } = options as any

    const params = {
      query: keyword,
      ...(sort && { index: sort }),
      ...Object.fromEntries(Object.entries(otherOptions).filter(([_, v]) => v !== undefined))
    }

    if (facets) {
      params['facets'] = JSON.stringify(parseFacets(facets))
    }

    const response = await ctx.http.get(`${MR_API_BASE}/search`, { params })
    return response.hits || []
  } catch (error) {
    ctx.logger.error('Modrinth 搜索失败:', error)
    return []
  }
}

// 详情函数
export async function getModrinthProject(ctx: Context, projectId: string) {
  try {
    // 移除并行请求，只获取项目信息
    const project = await ctx.http.get(`${MR_API_BASE}/project/${projectId}`)

    if (!project) return null

    const projectUrl = `https://modrinth.com/${project.project_type}/${project.slug}`
    const formatDate = date => date ? new Date(date).toLocaleString() : '未知'

    // 构建内容块
    const contentBlocks = []

    // 添加标题和图标
    contentBlocks.push(`【${project.title}】`)

    // 添加图标（如果有）
    if (project.icon_url) {
      contentBlocks.push(h.image(project.icon_url))
    }

    // 描述部分
    if (project.description) {
      contentBlocks.push(project.description)
    }

    // 基本信息
    contentBlocks.push([
      `项目类型: ${formatValue('type', project.project_type)}`,
      `作者: ${project.author || '未知'}`,
      `下载量: ${project.downloads?.toLocaleString() || '0'}`,
      `关注数: ${project.followers?.toLocaleString() || '0'}`,
      `状态: ${formatValue('project', project.status)}`,
      `货币化: ${formatValue('monetization', project.monetization_status)}`,
      `客户端: ${formatValue('compatibility', project.client_side)}`,
      `服务端: ${formatValue('compatibility', project.server_side)}`,
      `创建: ${formatDate(project.published)}`,
      `更新: ${formatDate(project.updated)}`,
      project.approved ? `审核通过: ${formatDate(project.approved)}` : null,
      `游戏版本: ${project.game_versions?.join(', ') || '未知'}`,
      `加载器: ${project.loaders?.join(', ') || '未知'}`,
      `主分类: ${project.categories?.join(', ') || '未知'}`,
      project.additional_categories?.length ? `附加分类: ${project.additional_categories.join(', ')}` : null,
      `许可: ${project.license?.id || '未知'}${project.license?.name ? ` (${project.license.name})` : ''}`
    ].filter(Boolean).map(item => `● ${item}`).join('\n'))

    // 相关链接
    const links = [
      project.source_url && `源代码: ${project.source_url}`,
      project.issues_url && `问题追踪: ${project.issues_url}`,
      project.wiki_url && `Wiki: ${project.wiki_url}`,
      project.discord_url && `Discord: ${project.discord_url}`
    ].filter(Boolean);

    if (links.length > 0) {
      contentBlocks.push(`◆ 相关链接 ◆\n${links.join('\n')}`)
    }

    // 捐赠信息
    if (project.donation_urls?.length > 0) {
      contentBlocks.push(`◆ 赞助渠道 ◆\n${project.donation_urls.map(d =>
        `● ${d.platform}: ${d.url}${d.id ? ` (${d.id})` : ''}`
      ).join('\n')}`)
    }

    // 图库
    if (project.gallery?.length > 0) {
      contentBlocks.push(`◆ 图库 ◆`)
      // 添加图片
      project.gallery.slice(0, 3).forEach(img => {
        contentBlocks.push(`${img.title || '图片'}:`)
        contentBlocks.push(h.image(img.url))
      })
    }

    // 简介
    if (project.body) {
      contentBlocks.push(`◆ 详细介绍 ◆\n${project.body.substring(0, 500).replace(/[#\-*]/g, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')}${project.body.length > 500 ? '...' : ''}`)
    }

    // 项目链接
    contentBlocks.push(`访问项目页面: ${projectUrl}`)

    return {
      content: contentBlocks,
      url: projectUrl,
      icon: project.icon_url || null
    }
  } catch (error) {
    ctx.logger.error('Modrinth 详情获取失败:', error)
    return null
  }
}

export function registerModrinth(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.modrinth <keyword:text>', '查询 Modrinth 资源')
    .option('type', '-t <type:string> 资源类型')
    .option('version', '-v <version:string> 游戏版本')
    .option('facets', '-f <facets:string> 高级过滤条件')
    .option('sort', '-s <sort:string> 排序方式(relevance/downloads/follows/newest/updated)')
    .option('shot', '--shot 使用截图模式')
    .option('icon', '--icon 显示项目图标')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        // 构建搜索参数
        const searchOptions: Record<string, any> = {
          facets: options.facets,
          sort: options.sort
        }

        // 添加常规过滤条件到 facets
        if (options.type || options.version) {
          let facetsArray = []

          if (options.type) {
            facetsArray.push([`project_type:${options.type}`])
          }

          if (options.version) {
            facetsArray.push([`versions:${options.version}`])
          }

          // 合并现有 facets
          if (searchOptions.facets) {
            const existingFacets = parseFacets(searchOptions.facets)
            facetsArray = [...facetsArray, ...existingFacets]
          }

          searchOptions.facets = JSON.stringify(facetsArray)
        }

        const projects = await searchModrinthProjects(ctx, keyword, searchOptions)
        if (!projects.length) return '未找到匹配的资源'

        const projectInfo = await getModrinthProject(ctx, projects[0].project_id)
        if (!projectInfo) return '获取资源详情失败'

        // 处理图标和内容展示
        let result
        if (options.icon && projectInfo.icon) {
          await session.send(h.image(projectInfo.icon))
          result = await renderOutput(
            session, projectInfo.content, projectInfo.url, ctx, config, options.shot
          )
        } else {
          result = await renderOutput(
            session, projectInfo.content, projectInfo.url, ctx, config, options.shot
          )
        }

        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('Modrinth 查询失败:', error)
        return '查询时发生错误，请稍后再试'
      }
    })
}
