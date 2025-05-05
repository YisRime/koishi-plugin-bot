import { Context, Command, Session } from 'koishi'
import { render, parseMode, renderList, safeRequest, cleanText, fetchPageContent, Result, SearchResults } from './utils'
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
async function parseMcmodResults(ctx: Context, query: string, getFullContent = false): Promise<{ results: Result[], total: number }> {
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

      // 如果需要获取完整内容且存在结果
      if (getFullContent && results.length > 0) {
        try {
          ctx.logger.info(`[MCMod] 尝试获取完整内容: ${results[0].url}`);
          const fullContent = await fetchPageContent(ctx, results[0].url);
          if (fullContent) {
            results[0].extract = fullContent;
            results[0].fullContent = true;
            ctx.logger.info(`[MCMod] 已获取完整内容，长度: ${fullContent.length}字符`);
          }
        } catch (error) {
          ctx.logger.warn(`[MCMod] 获取完整内容失败: ${error.message}`);
        }
      }

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
 * 提取MC百科页面内容
 */
export async function extractMcmodContent(page): Promise<string | null> {
  try {
    // 等待页面主要内容加载
    await page.waitForSelector('.class-info, .item-content', { timeout: 10000 })

    // 执行提取内容的脚本
    const content = await page.evaluate(() => {
      // 查找主要内容元素
      const contentElement = document.querySelector('.class-info') || document.querySelector('.item-content')
      if (!contentElement) return null

      // 提取标题和类型
      const titleElement = document.querySelector('.class-title h3') || document.querySelector('.item-name')
      const title = titleElement ? titleElement.textContent?.trim() : ''

      // 提取mod分类
      const categoryElement = document.querySelector('.class-category li a')
      const category = categoryElement ? categoryElement.getAttribute('class')?.replace('c_', '') : ''

      // 分类映射
      const categoryMap = {
        '1': '科技', '2': '魔法', '3': '冒险',
        '4': '农业', '5': '装饰', '21': '魔改',
        '23': '实用', '24': '辅助'
      }
      const categoryName = category ? categoryMap[category] || '其他' : ''

      // 构建标题部分
      let result = title ? `《${title}》` : ''
      if (categoryName) {
        result += ` [${categoryName}类]`
      }
      result += '\n\n'

      // 提取简介
      const introElement = document.querySelector('.class-info-intro') || document.querySelector('.item-desc')
      if (introElement) {
        const introText = introElement.textContent?.trim() || ''
        if (introText) {
          result += `${introText}\n\n`
        }
      }

      // 提取详细内容
      const detailElement = document.querySelector('.class-info-text') || document.querySelector('.item-content-text')
      if (detailElement) {
        // 处理内容中的标题和段落
        const childNodes = Array.from(detailElement.childNodes)
        let inBlock = false

        for (const node of childNodes) {
          // 处理标题
          if (node.nodeType === 1 && /^h[1-6]$/.test((node as Element).tagName.toLowerCase())) {
            const headingText = node.textContent?.trim() || ''
            if (headingText) {
              result += `\n【${headingText}】\n`
              inBlock = true
            }
          }
          // 处理段落
          else if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'p') {
            const paragraphText = node.textContent?.trim().replace(/\[.*?\]/g, '') || ''
            if (paragraphText) {
              result += inBlock ? paragraphText + '\n' : '\n' + paragraphText + '\n'
            }
          }
          // 处理DIV块
          else if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'div') {
            const blockText = node.textContent?.trim().replace(/\[.*?\]/g, '') || ''
            if (blockText) {
              result += inBlock ? blockText + '\n' : '\n' + blockText + '\n'
            }
          }
        }
      }

      // 提取信息表
      const infoTable = document.querySelector('.class-info-table') || document.querySelector('.item-info-table')
      if (infoTable) {
        result += '\n【基本信息】\n'

        const rows = Array.from(infoTable.querySelectorAll('tr'))
        for (const row of rows) {
          const name = row.querySelector('.name')?.textContent?.trim() || ''
          const value = row.querySelector('.value')?.textContent?.trim() || ''
          if (name && value) {
            result += `${name}：${value}\n`
          }
        }
      }

      // 清理格式
      return result
        .replace(/\[h\d=.*?\]/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    })

    return content
  } catch (error) {
    console.error('提取MC百科内容失败:', error)
    return null
  }
}

// 搜索MCMOD百科并返回第一个结果
export async function searchMcmod(ctx: Context, query: string): Promise<Result | null> {
  const { results } = await parseMcmodResults(ctx, query)

  // 如果有结果，尝试获取完整内容
  if (results.length > 0 && !results[0].fullContent) {
    try {
      const fullContent = await fetchPageContent(ctx, results[0].url, extractMcmodContent)
      if (fullContent) {
        results[0].extract = fullContent
        results[0].fullContent = true
        ctx.logger.info(`[MCMod] 已获取MC百科完整内容，长度: ${fullContent.length}字符`)
      }
    } catch (error) {
      ctx.logger.warn(`[MCMod] 获取完整内容失败: ${error.message}`)
    }
  }

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

      // 使用通用的 renderList 函数，传入摘要显示选项
      return renderList(
        session,
        searchResults,
        parseMode(options, config),
        { showExcerpt: options.excerpt !== false }
      )
    })
}
