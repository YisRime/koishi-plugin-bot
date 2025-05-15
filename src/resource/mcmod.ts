import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { MCMOD_MAPS } from './maps'

/**
 * 处理MCMOD介绍文本，提取图片和分段
 */
function processMcmodIntroduction(body: string, paragraphLimit: number): string[] {
  const images = []

  // 提取图片并替换为占位符，支持更多种格式的图片引用
  body = body.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    images.push(url)
    return `__IMAGE__${images.length - 1}__`
  })
    // 标准化标题格式
    .replace(/^(#+)\s+(.*?)$/gm, '\n$1 $2\n')
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/g, '\n## $1\n')
    // 处理HTML标签
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, '$1\n\n')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
    .replace(/<(?!\/?(strong|em|code|pre)\b)[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // 保留Markdown列表格式
    .replace(/^(\s*[-*]\s+)/gm, '• ')
    // 标准化换行
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const result = []

  // 分段处理
  const paragraphs = body.split('\n\n')
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i].trim()
    if (!paragraph) continue

    // 处理图片占位符 - 直接使用h.image
    const imageMatch = paragraph.match(/^__IMAGE__(\d+)__$/)
    if (imageMatch) {
      const imageIndex = parseInt(imageMatch[1])
      if (imageIndex >= 0 && imageIndex < images.length) {
        result.push(h.image(images[imageIndex])) // 直接转换为h.image对象
      }
      continue
    }

    // 处理标题段落 - 保持标题独立成段
    if (paragraph.match(/^#{1,6}\s/)) {
      result.push(paragraph)
      continue
    }

    // 处理列表项 - 尝试保持整个列表在一起
    if (paragraph.startsWith('• ') && i + 1 < paragraphs.length && paragraphs[i + 1].startsWith('• ')) {
      let listContent = paragraph
      let nextIndex = i + 1

      while (nextIndex < paragraphs.length && paragraphs[nextIndex].startsWith('• ')) {
        listContent += '\n' + paragraphs[nextIndex]
        i = nextIndex // 跳过已处理的列表项
        nextIndex++
      }

      if (listContent.length <= paragraphLimit) {
        result.push(listContent)
      } else {
        // 如果列表太长，按行分割
        const listItems = listContent.split('\n')
        let currentGroup = ''

        for (const item of listItems) {
          if ((currentGroup + '\n' + item).length > paragraphLimit && currentGroup) {
            result.push(currentGroup)
            currentGroup = item
          } else {
            currentGroup = currentGroup ? currentGroup + '\n' + item : item
          }
        }

        if (currentGroup) {
          result.push(currentGroup)
        }
      }
      continue
    }

    // 处理普通文本段落
    const cleanParagraph = paragraph.replace(/__IMAGE__\d+__/g, '').trim()
    if (!cleanParagraph) continue

    // 分割长段落
    if (cleanParagraph.length <= paragraphLimit) {
      result.push(cleanParagraph)
      continue
    }

    // 按句子或字符分段
    const sentenceBreaks = cleanParagraph.match(/[。！？\.!?]+/g)
    if (sentenceBreaks?.length > 5) {
      // 按句子分段
      let subParagraph = ''
      for (const sentence of cleanParagraph.split(/(?<=[。！？\.!?]+)/)) {
        if ((subParagraph + sentence).length > paragraphLimit) {
          if (subParagraph.trim()) result.push(subParagraph.trim())
          subParagraph = sentence
        } else {
          subParagraph += sentence
        }
      }
      if (subParagraph.trim()) result.push(subParagraph.trim())
    } else {
      // 按字符数分段
      for (let j = 0; j < cleanParagraph.length; j += paragraphLimit) {
        result.push(cleanParagraph.substring(j, j + paragraphLimit).trim())
      }
    }
  }

  return result
}

// 搜索MCMOD资源
export async function searchMcmodProjects(ctx: Context, keyword: string, options = {}, config: Config = null) {
  try {
    // 将偏移量转换为页码 (MCMOD每页固定30个结果)
    const pageSize = 30
    let page = 1

    if (options['page'] !== undefined) {
      page = options['page']
    } else if (options['offset'] !== undefined) {
      // 从偏移量转换为页码
      page = Math.floor(options['offset'] / pageSize) + 1
    }

    // 构建API参数
    const params = {
      q: keyword,
      page: page,
      ...(options['mold'] === 1 || options['mcmold'] ? { mold: 1 } : {}),
      ...(options['type'] && MCMOD_MAPS.FILTER[options['type']] > 0 ?
          { filter: MCMOD_MAPS.FILTER[options['type']] } : {})
    }

    // 获取API基础URL
    const apiBase = typeof config?.mcmodEnabled === 'string' ?
      (config.mcmodEnabled.trim().endsWith('/') ? config.mcmodEnabled.trim() : config.mcmodEnabled.trim() + '/') : ''

    const response = await ctx.http.get(`${apiBase}api/search`, { params })

    if (response?.results?.length) {
      return {
        results: response.results.map(item => ({
          id: item.id,
          name: item.name,
          description: item.description,
          type: item.type,
          url: item.url,
          category: item.category
        })),
        pagination: {
          page: response.page || 1,
          total: response.total || 1,
          totalResults: response.totalResults || response.results.length,
          pageSize: pageSize,
          offset: (response.page - 1) * pageSize  // 添加offset计算以便统一处理
        }
      }
    }
    return {
      results: [],
      pagination: {
        page: 1,
        total: 0,
        totalResults: 0,
        pageSize: pageSize,
        offset: 0
      }
    }
  } catch (error) {
    ctx.logger.error('MCMOD 搜索失败:', error)
    return {
      results: [],
      pagination: {
        page: 1,
        total: 0,
        totalResults: 0,
        pageSize: 0,
        offset: 0
      }
    }
  }
}

// 映射函数
const getMapValue = (map, key, defaultValue = `未知(${key})`) => map[key] || defaultValue

// 处理MCMOD资源详情
export async function getMcmodProject(ctx: Context, project, config: Config = null) {
  try {
    // 获取API基础URL
    const apiBase = typeof config?.mcmodEnabled === 'string' ?
      (config.mcmodEnabled.trim().endsWith('/') ? config.mcmodEnabled.trim() : config.mcmodEnabled.trim() + '/') : ''

    // 构建基本内容
    const basicContent = [
      `[${project.name}]`,
      project.description || '暂无描述',
      `类型: ${getMapValue(MCMOD_MAPS.TYPE, project.extra?.type, '未知')}`,
      `查看详情: ${project.url}`
    ]

    // 如果不是模组类型，返回基本信息
    if (project.extra?.type !== 'class') {
      return {
        content: basicContent,
        url: project.url,
        icon: null
      }
    }

    // 获取模组详细信息
    const params = {
      id: project.extra.id,
      others: false,
      community: project.community === true,
      relations: project.relations === true
    }

    const response = await ctx.http.get(`${apiBase}api/class`, { params })
    if (!response?.basicInfo) throw new Error('无法获取模组详情')

    const { basicInfo, compatibility, links, authors, resources, introduction, community, relations } = response

    // 模组名称
    const modName = [
      basicInfo.shortName,
      basicInfo.name,
      basicInfo.englishName ? `[${basicInfo.englishName}]` : null
    ].filter(Boolean).join(' ')

    // 作者信息
    const authorInfo = authors?.map(a =>
      `${a.name}${a.position ? ` (${a.position})` : ''}`).join(', ') || '未知'

    // 游戏版本信息
    let versionInfo = '未知'
    if (compatibility?.mcVersions) {
      const allVersions = []
      if (compatibility.mcVersions.forge) allVersions.push(`Forge: ${compatibility.mcVersions.forge.join(', ')}`)
      if (compatibility.mcVersions.fabric) allVersions.push(`Fabric: ${compatibility.mcVersions.fabric.join(', ')}`)
      if (compatibility.mcVersions.behaviorPack)
        allVersions.push(`行为包: ${compatibility.mcVersions.behaviorPack.join(', ')}`)
      versionInfo = allVersions.join('\n● ')
    }

    // 构建内容
    const content = [
      basicInfo.img && h.image(basicInfo.img),
      [
        modName,
        `状态: ${[basicInfo.status?.isActive ? '活跃' : '停更', basicInfo.status?.isOpenSource ? '开源' : '闭源'].join(', ')}`,
        `分类: ${basicInfo.categories?.map(id => getMapValue(MCMOD_MAPS.CATEGORY, id, `类别${id}`)).join(', ') || '未知'}`,
        `标签: ${basicInfo.tags?.join(', ') || '无标签'}`,
        `作者: ${authorInfo}`,
        `支持平台: ${compatibility?.platforms?.join(', ') || '未知'}`,
        `运作方式: ${compatibility?.apis?.join(', ') || '未知'}`,
        `运行环境: ${compatibility?.environment || '未知'}`,
        `支持版本:\n● ${versionInfo}`,
        `Mod资料:\n${resources.map(res => `● ${getMapValue(MCMOD_MAPS.RESOURCE_TYPE, res.typeId)} (${res.count}条)`).join('\n')}`,
      ].join('\n'),
      links?.length && `相关链接:\n${links.map(link => `● ${link.title}: ${link.url}`).join('\n')}`
    ].filter(Boolean)

    // 添加依赖关系信息
    if (project.relations && relations?.length) {
      const relationContent = []

      relationContent.push('模组关系:')
      for (const relation of relations) {
        if (relation.version) {
          relationContent.push(`【${relation.version}】版本：`)

          if (relation.dependencyMods?.length) {
            relationContent.push(`  依赖模组: ${relation.dependencyMods.map(mod => mod.name).join(', ')}`)
          }

          if (relation.relationMods?.length) {
            relationContent.push(`  关联模组: ${relation.relationMods.map(mod => mod.name).join(', ')}`)
          }
        }
      }

      if (relationContent.length > 1) {
        content.push(relationContent.join('\n'))
      }
    }

    // 添加社区信息
    if (community) {
      if (community.tutorials?.length) {
        content.push('Mod教程:')
        content.push(community.tutorials.map(t =>
          `● [${t.title}](https://www.mcmod.cn/post/${t.id}.html)`
        ).join('\n'))
      }

      if (community.discussions?.length) {
        content.push('Mod讨论:')
        content.push(community.discussions.map(d =>
          `● [${d.title}](https://bbs.mcmod.cn/thread-${d.id}-1-1.html)`
        ).join('\n'))
      }
    }

    // 处理详细介绍
    if (introduction) {
      content.push(`详细介绍：`)

      const introParts = processMcmodIntroduction(introduction, config.maxDescLength).slice(0, config.maxParagraphs)
      content.push(...introParts) // 直接添加处理后的内容，不需要再次转换

      if (processMcmodIntroduction(introduction, config.maxDescLength).length > config.maxParagraphs) {
        content.push('（更多内容请查看完整页面）')
      }
    }

    content.push(`查看详情: ${project.url}`)

    return {
      content,
      url: project.url,
      icon: basicInfo.img || null
    }
  } catch (error) {
    ctx.logger.error('MCMOD 详情获取失败:', error)
    return {
      content: [
        `[${project.name}]`,
        project.description || '暂无描述',
        `查看详情: ${project.url}`
      ],
      url: project.url,
      icon: null
    }
  }
}

// 注册 mcmod 命令
export function registerMcmod(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.mod <keyword:string>', '查询 MCMOD 百科')
    .option('type', '-t <type:string> 资源类型')
    .option('mold', '-m 启用复杂搜索')
    .option('community', '-c 获取教程讨论')
    .option('relations', '-r 显示模组关系')
    .option('shot', '-s 使用截图模式')
    .option('page', '-p <page:number> 页码')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'

      try {
        const projects = await searchMcmodProjects(ctx, keyword, {
          type: options.type,
          mold: options.mold ? 1 : 0,
          page: options.page
        }, config)

        if (!projects.results.length) return '未找到匹配的资源'

        const projectData = {
          name: projects.results[0].name,
          description: projects.results[0].description,
          url: projects.results[0].url,
          community: options.community,
          relations: options.relations,
          extra: { id: projects.results[0].id, type: projects.results[0].type, category: projects.results[0].category }
        }

        const projectInfo = await getMcmodProject(ctx, projectData, config)
        const result = await renderOutput(session, projectInfo.content, projectInfo.url, ctx, config, options.shot)

        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('MCMOD 查询失败:', error)
        return '查询时出错'
      }
    })
}
