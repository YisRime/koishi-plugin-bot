import { Context, Command } from 'koishi'
import { render, parseMode, renderList, safeRequest, cleanText, fetchPageContent, Result, SearchResults, Content, ContentType, SearchResultItem } from './utils'
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
  if (!normalizedUrl.startsWith('http')) {
    normalizedUrl = 'https://' + normalizedUrl
  } else if (normalizedUrl.startsWith('http:')) {
    normalizedUrl = normalizedUrl.replace('http:', 'https:')
  }

  // 过滤无效链接
  if (normalizedUrl.includes('/class/category/')) {
    ctx?.logger.info(`[MCMod] 过滤无效链接: ${normalizedUrl}`)
    return ''
  }

  return normalizedUrl
}

/**
 * 从HTML中提取搜索结果列表
 */
async function parseMcmodResults(ctx: Context, query: string): Promise<{ items: SearchResultItem[], total: number, queryUrl: string }> {
  const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(query)}&filter=0&site=1`
  ctx.logger.info(`[MCMod] 搜索: "${query}"`)
  ctx.logger.info(`[MCMod] 请求链接: ${searchUrl}`)

  try {
    const html = await safeRequest(ctx, searchUrl, {}, { responseType: 'text' })

    // 提取总结果数
    const totalMatch = html.match(/找到约\s*(\d+)\s*条结果/i)
    const total = totalMatch ? parseInt(totalMatch[1]) : 0

    const items: SearchResultItem[] = []

    // 提取结果项
    const resultItems = html.match(/<div class="result-item">[\s\S]*?<\/div>\s*<\/div>/g) || []

    for (const itemHtml of resultItems) {
      if (items.length >= 20) break; // 限制最多20个结果

      try {
        // 查找URL和标题
        const linkRegex = /<a\s+[^>]*?href="(https?:\/\/www\.mcmod\.cn\/class\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
        const altLinkRegex = /<a\s+[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;

        let rawUrl = '', title = '';

        // 优先查找完整URL格式的链接
        const linkMatch = itemHtml.match(linkRegex);
        if (linkMatch) {
          rawUrl = linkMatch[1];
          title = cleanMcmodText(linkMatch[2].replace(/<[^>]*>/g, ''));
        } else {
          // 尝试查找任何形式的链接
          const altMatch = itemHtml.match(altLinkRegex);
          if (!altMatch) continue;

          rawUrl = altMatch[1];
          title = cleanMcmodText(altMatch[2].replace(/<[^>]*>/g, ''));
        }

        const url = normalizeUrl(rawUrl, ctx);
        if (!url) continue;

        // 提取正文内容
        const bodyMatch = itemHtml.match(/<div class="body">([\s\S]*?)<\/div>/i);
        let excerpt = '';
        if (bodyMatch) {
          const bodyHtml = bodyMatch[1];
          excerpt = cleanMcmodText(bodyHtml.replace(/<em>(.*?)<\/em>/g, '$1').replace(/<[^>]*>/g, ''));
        }

        // 提取分类信息
        let category = '';
        const categoryMatch = itemHtml.match(/<div class="class-category"><ul><li><a class="([^"]+)" href="[^"]+\/class\/category\/[^"]+" target="_blank"><\/a>/i);
        if (categoryMatch) {
          const categoryClass = categoryMatch[1];
          const categoryMap = {
            'c_1': '科技', 'c_2': '魔法', 'c_3': '冒险',
            'c_4': '农业', 'c_5': '装饰', 'c_21': '魔改',
            'c_23': '实用', 'c_24': '辅助'
          };
          category = categoryMap[categoryClass] || '其他';
        }

        // 提取页脚信息
        const footMatch = itemHtml.match(/<div class="foot">([\s\S]*?)<\/div>/i);
        let snapshot = '', source = '';

        if (footMatch) {
          const snapshotMatch = footMatch[1].match(/快照时间：<\/span><span class="value">([^<]+)<\/span>/);
          if (snapshotMatch) snapshot = snapshotMatch[1].trim();

          const sourceMatch = footMatch[1].match(/来自：<\/span><span class="value"><a[^>]*>([^<]+)<\/a>/);
          if (sourceMatch) source = sourceMatch[1].trim();
        }

        // 增强描述
        let enhancedExcerpt = excerpt;
        const infoDetails = [];

        if (category) infoDetails.push(`分类：${category}`);
        if (snapshot) infoDetails.push(`快照时间：${snapshot}`);
        if (source) infoDetails.push(`来源：${source}`);

        if (infoDetails.length > 0) {
          enhancedExcerpt += `\n\n${infoDetails.join(' | ')}`;
        }

        // 添加到结果
        items.push({
          title,
          url,
          excerpt: enhancedExcerpt,
          source: 'mcmod',
          category
        });
      } catch (error) {
        ctx.logger.warn(`[MCMod] 解析结果项失败: ${error.message}`);
      }
    }

    ctx.logger.info(`[MCMod] 搜索成功，找到 ${items.length} 条结果`);
    return { items, total, queryUrl: searchUrl };
  } catch (error) {
    ctx.logger.error(`[MCMod] 搜索失败: ${error.message}`);
    return { items: [], total: 0, queryUrl: searchUrl };
  }
}

/**
 * 提取MC百科页面内容
 */
export async function extractMcmodContent(page): Promise<string | null> {
  try {
    await page.waitForSelector('.class-menu-main, .item-content', { timeout: 10000 })

    return await page.evaluate(() => {
      function cleanText(text: string): string {
        if (!text) return '';
        return text.replace(/\s+/g, ' ')
          .replace(/\[.*?\]/g, '')
          .trim();
      }

      // 获取标题和状态信息
      const shortName = document.querySelector('.class-title .short-name')?.textContent?.trim() || '';
      const modTitle = document.querySelector('.class-title h3')?.textContent?.trim() || '';
      const modSubtitle = document.querySelector('.class-title h4')?.textContent?.trim() || '';
      const statusLabels = Array.from(document.querySelectorAll('.class-status, .class-source'))
        .map(el => el.textContent?.trim() || '')
        .filter(Boolean);

      // 构建标题部分
      let result = `${shortName} ${modSubtitle} | ${modTitle}`;
      if (statusLabels.length > 0) {
        result += ` (${statusLabels.join(' | ')})`;
      }
      result += '\n\n';

      // 提取运作方式和运行环境
      const infoItems = document.querySelectorAll('.class-info-left .col-lg-4');
      let runMode = '', runEnv = '';

      infoItems.forEach(item => {
        const text = item.textContent?.trim() || '';
        if (text.includes('运作方式:')) {
          runMode = text.replace('运作方式:', '').trim();
        } else if (text.includes('运行环境:')) {
          runEnv = text.replace('运行环境:', '').trim();
        }
      });

      if (runMode) result += `运作方式: ${runMode}\n`;
      if (runEnv) result += `运行环境: ${runEnv}\n`;

      // 提取支持版本
      const mcverElement = document.querySelector('.col-lg-12.mcver');
      if (mcverElement) {
        result += '支持版本:\n';

        // 简化版本号显示的辅助函数
        function simplifyVersions(versions) {
          const groupedVersions = {};
          versions.forEach(version => {
            const match = version.match(/^(\d+\.\d+)/);
            if (match) {
              const mainVersion = match[1];
              if (!groupedVersions[mainVersion]) {
                groupedVersions[mainVersion] = [];
              }
              groupedVersions[mainVersion].push(version);
            }
          });

          const result = [];
          for (const mainVersion in groupedVersions) {
            const count = groupedVersions[mainVersion].length;
            result.push(count === 1 ?
              groupedVersions[mainVersion][0] :
              `${mainVersion}(${count}个版本)`);
          }

          return result.join(', ');
        }

        // 获取所有版本分类
        const versionCategories = mcverElement.querySelectorAll('ul');
        versionCategories.forEach(category => {
          const categoryTitle = category.querySelector('li')?.textContent?.trim() || '';
          if (categoryTitle) {
            const versions = Array.from(category.querySelectorAll('li:not(:first-child)'))
              .map(li => li.textContent?.trim() || '')
              .filter(Boolean);

            if (versions.length > 0) {
              result += `${categoryTitle} ${simplifyVersions(versions)}\n`;
            }
          }
        });
      }

      // 提取相关链接
      const linksSection = document.querySelector('.common-link-frame');
      if (linksSection) {
        result += '相关链接:\n';
        const linkItems = document.querySelectorAll('.common-link-icon-frame li');

        linkItems.forEach(item => {
          const linkName = item.querySelector('.name')?.textContent?.trim() || '';
          const linkTitle = item.querySelector('a')?.getAttribute('data-original-title') ||
                           item.querySelector('a')?.getAttribute('title') || '';
          const linkHref = item.querySelector('a')?.getAttribute('href') || '';

          // 提取真实URL（处理跳转链接）
          let realUrl = '';
          if (linkHref && linkHref.includes('link.mcmod.cn/target/')) {
            const encodedUrl = linkHref.split('link.mcmod.cn/target/')[1];
            if (encodedUrl) {
              try {
                realUrl = atob(encodedUrl);
              } catch (e) {
                realUrl = linkHref;
              }
            }
          } else {
            realUrl = linkHref;
          }

          if (linkName && realUrl) {
            result += `${linkName}`;
            if (linkTitle && linkTitle !== linkName) {
              result += ` (${linkTitle})`;
            }
            result += `: ${realUrl}\n`;
          }
        });
      }

      // 提取简介内容
      result += '简介:\n';
      const introElement = document.querySelector('.common-text');
      if (introElement) {
        const introTitle = introElement.querySelector('.common-text-title:nth-of-type(1)');
        const introText = [];

        // 从简介标题开始，收集直到下一个标题为止的段落
        if (introTitle) {
          let currentElement = introTitle.nextElementSibling;
          while (currentElement && !currentElement.classList.contains('common-text-title')) {
            if (currentElement.tagName.toLowerCase() === 'p') {
              const paragraphText = cleanText(currentElement.textContent || '');
              if (paragraphText) {
                introText.push(paragraphText);
              }
            }
            currentElement = currentElement.nextElementSibling;
          }
        }

        // 如果找不到专门的简介部分，则从开头提取一部分段落作为简介
        if (introText.length === 0) {
          const paragraphs = introElement.querySelectorAll('p');
          let count = 0;
          paragraphs.forEach(p => {
            if (count < 3) { // 最多提取3段
              const paragraphText = cleanText(p.textContent || '');
              if (paragraphText) {
                introText.push(paragraphText);
                count++;
              }
            }
          });
        }

        if (introText.length > 0) {
          result += `『简介』\n${introText.join('\n\n')}\n`;
        }
      }

      return result;
    });
  } catch (error) {
    console.error('提取MC百科内容失败:', error);
    return null;
  }
}

// 获取MC百科词条详细内容
export async function getMcmodDetail(ctx: Context, title: string, url?: string): Promise<Result | null> {
  try {
    ctx.logger.info(`[MCMod] 获取词条详情: ${title}`)

    // 如果没有提供URL，则需要搜索获取URL
    if (!url) {
      const searchResults = await parseMcmodResults(ctx, title)
      const exactMatch = searchResults.items.find(item =>
        item.title.toLowerCase() === title.toLowerCase()
      )

      // 获取最匹配的结果
      const bestMatch = exactMatch || searchResults.items[0]
      if (!bestMatch) return null

      url = bestMatch.url
      if (!url) return null

      // 如果通过搜索找到了结果，使用搜索结果的标题
      title = bestMatch.title
    }

    // 创建结果对象
    const result: Result = {
      title,
      url,
      contents: [{
        type: ContentType.TEXT,
        value: '正在获取内容...'
      }],
      source: 'mcmod'
    }

    // 获取完整内容
    try {
      const fullContent = await fetchPageContent(ctx, url, extractMcmodContent)
      if (fullContent) {
        result.contents = [{
          type: ContentType.FULL_EXTRACT,
          value: fullContent
        }]
        ctx.logger.info(`[MCMod] 已获取完整内容，长度: ${fullContent.length}字符`)
      }
    } catch (error) {
      ctx.logger.warn(`[MCMod] 获取完整内容失败: ${error.message}`)
      result.contents = [{
        type: ContentType.TEXT,
        value: '获取内容失败，请直接访问链接查看详情。'
      }]
    }

    return result
  } catch (error) {
    ctx.logger.error(`[MCMod] 获取词条详情失败: ${error.message}`)
    return null
  }
}

// 搜索MCMOD百科并返回第一个结果
export async function searchMcmod(ctx: Context, query: string): Promise<Result | null> {
  const searchResults = await parseMcmodResults(ctx, query)

  if (searchResults.items.length > 0) {
    const firstItem = searchResults.items[0]
    return await getMcmodDetail(ctx, firstItem.title, firstItem.url)
  }

  return null
}

// 搜索MCMOD百科并返回多个结果
export async function searchMcmodList(ctx: Context, query: string): Promise<SearchResults> {
  const { items, total, queryUrl } = await parseMcmodResults(ctx, query)
  return { query, queryUrl, total, items }
}

// 注册MCMOD搜索命令
export function registerMod(ctx: Context, mc: Command, config?: Config) {
  // 提供方法给其他模块调用
  ctx.provide('mcmod_getDetail', (title: string, url?: string) => getMcmodDetail(ctx, title, url))

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
      if (searchResults.items.length === 0) return '未找到相关百科词条'

      return renderList(
        session,
        searchResults,
        parseMode(options, config),
        { showExcerpt: options.excerpt !== false }
      )
    })
}
