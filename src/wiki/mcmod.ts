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
    await page.waitForSelector('.class-menu-main, .item-content', { timeout: 10000 })

    // 执行提取内容的脚本
    const content = await page.evaluate(() => {
      function cleanText(text: string): string {
        if (!text) return '';
        return text.replace(/\s+/g, ' ')
          .replace(/\[.*?\]/g, '')
          .trim();
      }

      // 获取标题
      const modTitle = document.querySelector('.class-title h3')?.textContent?.trim() || '';
      const modSubtitle = document.querySelector('.class-title h4')?.textContent?.trim() || '';

      // 获取分类信息
      const categoryElements = document.querySelectorAll('.common-class-category li a');
      const categories = Array.from(categoryElements)
        .map(el => {
          // 尝试从title或data-original-title属性获取分类名称
          return el.getAttribute('data-original-title') ||
                 el.getAttribute('title') ||
                 el.textContent?.trim() || '';
        })
        .filter(text => text && !text.includes('common-icon-category'));

      // 构建标题部分
      let result = modTitle ? `《${modTitle}` : '';
      if (modSubtitle) result += ` (${modSubtitle})`;
      result += '》\n';

      if (categories.length > 0) {
        result += `[${categories.join(' / ')}]\n`;
      }
      result += '\n';

      // 提取模组基本信息
      const infoItems = document.querySelectorAll('.class-info-left .col-lg-4, .class-info-left li');
      if (infoItems.length > 0) {
        result += '【基本信息】\n';
        infoItems.forEach(item => {
          const text = cleanText(item.textContent || '');
          if (text && !text.includes('模组标签') && !text.includes('相关链接')) {
            result += `${text}\n`;
          }
        });
        result += '\n';
      }

      // 提取模组介绍内容
      const introElement = document.querySelector('.common-text');
      if (introElement) {
        // 提取正文中的所有标题和段落
        const contentNodes = introElement.querySelectorAll('p, .common-text-title, ul, ol, table, h1, h2, h3, h4, h5, h6');

        contentNodes.forEach(node => {
          const tagName = node.tagName.toLowerCase();

          // 处理标题
          if (tagName.startsWith('h') || node.classList.contains('common-text-title')) {
            const titleText = cleanText(node.textContent || '');
            if (titleText) {
              result += `\n【${titleText}】\n`;
            }
          }
          // 处理段落
          else if (tagName === 'p') {
            const paragraphText = cleanText(node.textContent || '');
            if (paragraphText) {
              result += `${paragraphText}\n\n`;
            }
          }
          // 处理列表
          else if (tagName === 'ul' || tagName === 'ol') {
            const listItems = node.querySelectorAll('li');
            listItems.forEach((item, index) => {
              const itemText = cleanText(item.textContent || '');
              if (itemText) {
                result += tagName === 'ol' ? `${index + 1}. ${itemText}\n` : `• ${itemText}\n`;
              }
            });
            result += '\n';
          }
          // 处理表格
          else if (tagName === 'table') {
            const rows = node.querySelectorAll('tr');
            rows.forEach(row => {
              const cells = row.querySelectorAll('th, td');
              const rowContent = Array.from(cells)
                .map(cell => cleanText(cell.textContent || ''))
                .filter(Boolean)
                .join(' | ');
              if (rowContent) {
                result += `${rowContent}\n`;
              }
            });
            result += '\n';
          }
        });
      }

      // 提取相关链接
      const linksSection = document.querySelector('.common-link-frame');
      if (linksSection) {
        const linkItems = linksSection.querySelectorAll('.common-link-icon-frame li');
        if (linkItems.length > 0) {
          result += '\n【相关链接】\n';
          linkItems.forEach(item => {
            const linkName = item.querySelector('.name')?.textContent?.trim() || '';
            const linkTitle = item.querySelector('a')?.getAttribute('data-original-title') ||
                             item.querySelector('a')?.getAttribute('title') || '';

            if (linkName) {
              result += `• ${linkName}`;
              if (linkTitle && linkTitle !== linkName) {
                result += `: ${linkTitle}`;
              }
              result += '\n';
            }
          });
        }
      }

      // 提取版本信息
      const versionItems = document.querySelectorAll('.common-rowlist.log li a');
      if (versionItems.length > 0) {
        result += '\n【最近更新】\n';
        let count = 0;
        versionItems.forEach(item => {
          if (count < 5) {  // 只显示最近5个版本
            const versionText = item.textContent?.trim() || '';
            const timeElement = item.nextElementSibling;
            const timeText = timeElement?.textContent?.trim() || '';

            if (versionText) {
              result += `• ${versionText}`;
              if (timeText) {
                result += ` (${timeText})`;
              }
              result += '\n';
              count++;
            }
          }
        });
      }

      // 清理结果
      return result
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    });

    return content;
  } catch (error) {
    console.error('提取MC百科内容失败:', error);
    return null;
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
