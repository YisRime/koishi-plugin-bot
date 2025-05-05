import { Context, Command } from 'koishi'
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

        results.push({ title, url, extract, source: 'mcmod' });
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
    .action(async ({ session, options }, query) => {
      if (!query) return '请输入要搜索的内容'
      const searchResults = await searchMcmodList(ctx, query)
      return searchResults.results.length === 0
        ? '未找到相关百科词条'
        : renderList(session, searchResults, parseMode(options, config))
    })
}
