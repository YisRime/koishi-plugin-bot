import { Context, Command, Session } from 'koishi'
import { render, parseMode, renderList, safeRequest, cleanText, Result, SearchResults } from './utils'
import { Config } from '../index'

/**
 * MCMod百科特有的文本清理函数
 */
function cleanMcmodText(text: string): string {
  return cleanText(text
    .replace(/\[\w+:[^]]*\]/g, '')
    .replace(/\[h\d=.*?\]/g, '')
    .replace(/\[.*?\]/g, '')
  )
}

/**
 * 规范化MCMOD链接
 */
function normalizeUrl(url: string, ctx?: Context): string {
  if (!url) return ''

  // 添加https前缀并确保使用HTTPS
  let normalizedUrl = url
  if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl
  else if (normalizedUrl.startsWith('http:')) normalizedUrl = normalizedUrl.replace('http:', 'https:')

  // 过滤无效链接
  const isInvalid = normalizedUrl.includes('/class/category/')
  const result = isInvalid ? '' : normalizedUrl

  if (ctx) {
    if (isInvalid) {
      ctx.logger.info(`[MCMod] 过滤无效链接: ${normalizedUrl}`)
    } else if (normalizedUrl !== url) {
      ctx.logger.info(`[MCMod] 规范化链接: ${url} -> ${normalizedUrl}`)
    }
  }

  return result
}

/**
 * 从HTML中提取搜索结果
 */
async function parseMcmodResults(ctx: Context, query: string): Promise<{ results: Result[], total: number }> {
  const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(query)}&filter=0&site=1`
  ctx.logger.info(`[MCMod] 搜索: "${query}"`)
  ctx.logger.info(`[MCMod] 请求链接: ${searchUrl}`)

  try {
    const html = await safeRequest(ctx, searchUrl, {}, { responseType: 'text' })

    // 提取总结果数
    const totalMatch = html.match(/找到约\s*(\d+)\s*条结果/i)
    const total = totalMatch ? parseInt(totalMatch[1]) : 0

    // 提取所有结果项
    const results: Result[] = []

    // 使用一个函数提取所有结果项
    const extractResults = () => {
      // 首先尝试获取所有结果项
      const resultItems = html.match(/<div class="result-item">[\s\S]*?<\/div>\s*<\/div>/g) || []

      resultItems.forEach(itemHtml => {
        if (results.length >= 20) return // 限制最多20个结果

        try {
          // 直接从result-item中查找带有href的<a>标签
          // 注意查找格式为 <a target="_blank" href="https://www.mcmod.cn/class/..."
          const linkRegex = /<a\s+[^>]*?href="(https?:\/\/www\.mcmod\.cn\/class\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
          const linkMatch = itemHtml.match(linkRegex);

          if (!linkMatch) {
            // 如果没找到完整URL格式的链接，尝试查找任何形式的链接
            const altLinkRegex = /<a\s+[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
            const altMatch = itemHtml.match(altLinkRegex);

            if (!altMatch) {
              ctx.logger.debug(`[MCMod] 未在结果项中找到链接`);
              return;
            }

            // 使用备用匹配结果
            const rawUrl = altMatch[1];
            const url = normalizeUrl(rawUrl, ctx);
            if (!url) return;

            const title = cleanMcmodText(altMatch[2].replace(/<[^>]*>/g, ''));
            extractBodyContent(itemHtml, title, url);
          } else {
            // 找到了完整URL格式的链接
            const rawUrl = linkMatch[1];
            ctx.logger.info(`[MCMod] 提取到完整格式链接: ${rawUrl}`);
            const url = normalizeUrl(rawUrl, ctx);
            if (!url) return;

            const title = cleanMcmodText(linkMatch[2].replace(/<[^>]*>/g, ''));
            extractBodyContent(itemHtml, title, url);
          }
        } catch (error) {
          ctx.logger.warn(`[MCMod] 解析结果项失败: ${error.message}`);
        }
      });

      // 辅助函数：提取正文内容并添加到结果
      function extractBodyContent(itemHtml: string, title: string, url: string) {
        ctx.logger.info(`[MCMod] 处理结果: 标题 "${title}", 链接 ${url}`);

        // 提取正文内容
        const bodyMatch = itemHtml.match(/<div class="body">([\s\S]*?)<\/div>/i);
        let extract = '';
        if (bodyMatch) {
          const bodyHtml = bodyMatch[1];
          extract = cleanMcmodText(bodyHtml.replace(/<em>(.*?)<\/em>/g, '$1').replace(/<[^>]*>/g, ''));
        }

        // 提取页脚信息
        const footerInfo: Record<string, string> = {};
        const footMatch = itemHtml.match(/<div class="foot">([\s\S]*?)<\/div>/i);
        if (footMatch) {
          // 提取快照时间
          const snapshotMatch = footMatch[1].match(/快照时间：<\/span><span class="value">([^<]+)<\/span>/);
          if (snapshotMatch) {
            footerInfo['snapshot'] = snapshotMatch[1].trim();
          }

          // 提取来源
          const sourceMatch = footMatch[1].match(/来自：<\/span><span class="value"><a[^>]*>([^<]+)<\/a>/);
          if (sourceMatch) {
            footerInfo['source'] = sourceMatch[1].trim();
          }
        }

        // 提取分类信息
        let category = '';
        const categoryMatch = itemHtml.match(/<div class="class-category"><ul><li><a class="([^"]+)" href="[^"]+\/class\/category\/[^"]+" target="_blank"><\/a>/i);
        if (categoryMatch) {
          const categoryClass = categoryMatch[1]; // 例如 c_1, c_23 等
          // 转换分类代码到分类名称
          const categoryMap: Record<string, string> = {
            'c_1': '科技', 'c_2': '魔法', 'c_3': '冒险',
            'c_4': '农业', 'c_5': '装饰', 'c_21': '魔改',
            'c_23': '实用', 'c_24': '辅助'
          };
          category = categoryMap[categoryClass] || '其他';
        }

        // 构建增强的描述
        let enhancedExtract = extract;

        // 添加分类和页脚信息到描述末尾
        const infoDetails = [];
        if (category) {
          infoDetails.push(`分类：${category}`);
        }
        if (footerInfo.snapshot) {
          infoDetails.push(`快照时间：${footerInfo.snapshot}`);
        }
        if (footerInfo.source) {
          infoDetails.push(`来源：${footerInfo.source}`);
        }

        if (infoDetails.length > 0) {
          enhancedExtract += `\n\n${infoDetails.join(' | ')}`;
        }

        results.push({
          title,
          url,
          extract: enhancedExtract,
          source: 'mcmod'
        });
      }
    };

    // 提取搜索结果
    extractResults();

    ctx.logger.info(`[MCMod] 搜索成功，找到 ${results.length} 条结果`);
    if (results.length > 0) {
      ctx.logger.info(`[MCMod] 第一条结果: ${results[0].title} - ${results[0].url}`);
      if (results[0].extract) {
        const excerpt = results[0].extract.substring(0, 100) + '...';
        ctx.logger.info(`[MCMod] 内容概览: ${excerpt}`);
      }
    }

    return { results, total };
  } catch (error) {
    ctx.logger.error(`[MCMod] 搜索失败: ${error.message}`);
    return { results: [], total: 0 };
  }
}

/**
 * 为MCMod百科定制的搜索结果列表渲染，包含内容概览
 */
async function renderMcmodList(
  session: Session,
  searchResults: SearchResults,
  mode: 'text' | 'fwd' | 'shot' = 'text',
  showExcerpt: boolean = true
): Promise<any> {
  if (!searchResults?.results?.length) return '未找到相关词条'

  // 过滤掉无效链接的结果
  const validResults = searchResults.results.filter(result => result.url && result.title)

  if (session.app.logger && validResults.length > 0) {
    const logger = session.app.logger
    logger.info(`[MCMod] 生成搜索结果列表，共 ${validResults.length} 项`)
    validResults.forEach((result, i) => {
      logger.info(`[MCMod] 列表项 ${i+1}: ${result.title} - ${result.url}`)
      if (result.extract && result.extract.length > 0) {
        const excerpt = result.extract.substring(0, 80) + '...'
        logger.info(`[MCMod] 内容概览 ${i+1}: ${excerpt}`)
      }
    })
  }

  if (!validResults.length) return '未找到有效的搜索结果'

  // 生成所有结果的列表，优化显示格式，包含内容概览
  const listText = validResults.map((result, i) => {
    // 确保标题和URL都正确显示，如果标题为空则显示"未命名"
    const displayTitle = result.title.trim() || '未命名词条'

    // 提取分类信息
    let categoryInfo = ''
    if (result.extract && result.extract.includes('分类：')) {
      const categoryMatch = result.extract.match(/分类：([^|]+)/)
      if (categoryMatch) {
        categoryInfo = `[${categoryMatch[1].trim()}] `
      }
    }

    let itemText = `${i + 1}. ${categoryInfo}${displayTitle}\n   ${result.url}`

    // 如果配置了显示摘要并且存在摘要，添加到列表项
    if (showExcerpt && result.extract) {
      // 从摘要中去除元数据部分（通常在 \n\n 后面）
      let excerpt = result.extract
      const metadataPos = excerpt.indexOf('\n\n分类：')
      if (metadataPos > -1) {
        excerpt = excerpt.substring(0, metadataPos)
      }

      // 限制摘要长度
      if (excerpt.length > 100) {
        excerpt = excerpt.substring(0, 100) + '...'
      }

      itemText += `\n   ${excerpt}`
    }

    return itemText
  }).join('\n\n')

  const promptText = `找到 ${searchResults.total || validResults.length} 条相关词条，请回复数字选择查看详情：`

  // 发送结果列表
  const sendList = async () => {
    await session.send(promptText)
    await session.send(listText)
  }

  // 根据平台和模式选择显示方式
  if (mode === 'fwd' && session.platform === 'onebot') {
    try {
      const fwdMsgs = [
        { type: 'node', data: { name: 'MC百科搜索', uin: session.selfId || '10000', content: promptText } },
        { type: 'node', data: { name: 'MC百科搜索', uin: session.selfId || '10000', content: listText } }
      ]

      const onebot = session.bot
      if (onebot) {
        if (session.guildId) {
          await onebot.internal.sendGroupForwardMsg(session.guildId, fwdMsgs)
        } else if (session.userId) {
          await onebot.internal.sendPrivateForwardMsg(session.userId, fwdMsgs)
        } else {
          await sendList()
        }
      } else {
        await sendList()
      }
    } catch (error) {
      session.app.logger.warn(`[MCMod] 合并转发失败: ${error.message}`)
      await sendList()
    }
  } else {
    await sendList()
  }

  // 等待用户选择
  try {
    const response = await session.prompt(30 * 1000)
    const selection = parseInt(response)

    if (isNaN(selection) || selection < 1 || selection > validResults.length) {
      return '选择无效，已取消查询'
    }

    // 返回完整的结果对象以便详细查看
    const selectedResult = validResults[selection - 1]
    return render(session.app, session, selectedResult, mode)
  } catch {
    return '查询已超时或被取消'
  }
}

// 搜索MCMOD百科并返回第一个结果
export async function searchMcmod(ctx: Context, query: string): Promise<Result | null> {
  const { results } = await parseMcmodResults(ctx, query)
  return results.length > 0 ? results[0] : null
}

// 搜索MCMOD百科并返回多个结果
export async function searchMcmodList(ctx: Context, query: string): Promise<SearchResults> {
  const { results, total } = await parseMcmodResults(ctx, query)
  return { query, total, results }
}

// 注册MCMOD搜索命令
export function registerMod(ctx: Context, mc: Command, config?: Config) {
  // 主命令：查询单个结果
  const mod = mc.subcommand('.mod <query:text>', '查询MC百科词条')
    .option('visual', '-v <mode:string>', { fallback: '' })
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要查询的内容'
      const result = await searchMcmod(ctx, query)
      return render(ctx, session, result, parseMode(options, config))
    })

  // 子命令：搜索多个结果
  mod.subcommand('.search <query:text>', '搜索MC百科显示多个结果')
    .option('visual', '-v <mode:string>', { fallback: '' })
    .option('excerpt', '-e', { fallback: true })
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要搜索的内容'
      const searchResults = await searchMcmodList(ctx, query)
      if (searchResults.results.length === 0) return '未找到相关百科词条'

      // 使用自定义渲染函数，而不是通用的renderList
      return renderMcmodList(
        session,
        searchResults,
        parseMode(options, config),
        options.excerpt !== false
      )
    })
}
