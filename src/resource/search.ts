import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { PLATFORMS } from './map'

/**
 * CurseForge 资源类型 ID 映射
 * 用于将人类可读的资源类型转换为 API 所需的数字 ID
 * @type {Record<string, number>}
 */
const cfTypeMap = {
  'mod': 6, 'resourcepack': 12, 'world': 17, 'plugin': 5,
  'modpack': 4471, 'addon': 4559, 'customization': 4546,
  'shader': 6552, 'datapack': 6945
}

/**
 * CurseForge 加载器类型映射
 * 将加载器名称转换为 API 所需的数字 ID
 * @type {Record<string, number>}
 */
const cfLoaderMap = {
  'any': 0, 'forge': 1, 'cauldron': 2, 'liteloader': 3,
  'fabric': 4, 'quilt': 5, 'neoforge': 6
}

/**
 * 搜索结果缓存
 * 用于存储用户会话的搜索结果，支持分页浏览
 * @type {Map<string, {results: Array<any>, keyword: string, page: number, options: object}>}
 */
const searchResultsCache = new Map();

/**
 * 注册搜索命令
 * @param {Context} ctx - Koishi 上下文
 * @param {Command} mc - Minecraft 主命令
 * @param {Config} config - 插件配置
 */
export function registerSearch(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.search <keyword:text>', '搜索 Minecraft 资源')
    .option('mr', '-mr 搜索 Modrinth')
    .option('cf', '-cf 搜索 CurseForge')
    .option('mcmod', '-mod 搜索 MCMOD 百科')
    .option('mcwiki', '-wiki 搜索 Minecraft Wiki')
    .option('all', '-a 搜索所有平台')
    .option('shot', '-s 使用截图模式')
    .option('type', `-t <type:string> 资源类型(${Object.keys(cfTypeMap).join('|')})`)
    .option('version', '-v <version:string> 支持版本')
    .option('offset', '-o <offset:number> 跳过结果')
    .option('limit', '-n <limit:number> 结果数量')
    .option('mrs', '-mrs <sort:string> [MR]排序方式')
    .option('mrf', '-mrf <facets:string> [MR]高级过滤')
    .option('cfl', '-cfl <loader:string> [CF]加载器')
    .option('cfs', '-cfs <sort:string> [CF]排序方式')
    .option('cfo', '-cfo <order:string> [CF]升降序')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入搜索关键词'
      try {
        const sessionId = `${session.platform}:${session.userId}`;
        let currentPage = 0;
        let cachedResults = [];
        // 检查缓存
        if (searchResultsCache.has(sessionId) && !options.offset) {
          const existingData = searchResultsCache.get(sessionId);
          if (existingData.keyword === keyword) {
            currentPage = existingData.page || 0;
            cachedResults = existingData.results || [];
          }
        }
        // 计算偏移量
        let effectiveOffset = options.offset;
        if (!options.offset) {
          if (cachedResults.length > 0) {
            const searchData = searchResultsCache.get(sessionId);
            searchData.page = currentPage;
            searchResultsCache.set(sessionId, searchData);
          } else if (currentPage > 0) {
            effectiveOffset = currentPage * config.searchResults;
          }
        }
        if (cachedResults.length === 0) {
          // 确定搜索平台
          const platformsToSearch = options.all ? Object.keys(PLATFORMS) :
            [options.mr && 'modrinth', options.cf && 'curseforge',
             options.mcmod && 'mcmod', options.mcwiki && 'mcwiki']
              .filter(Boolean).length ?
                [options.mr && 'modrinth', options.cf && 'curseforge',
                 options.mcmod && 'mcmod', options.mcwiki && 'mcwiki'].filter(Boolean) :
                ['modrinth', 'curseforge'];
          // 检查平台配置
          const platformOptions = {
            modrinth: {
              facets: options.mrf || (options.type && JSON.stringify([[`project_type:${options.type}`]])),
              sort: options.mrs, version: options.version, offset: effectiveOffset,
              limit: options.limit ? Math.min(options.limit, 100) : Math.min(config.searchResults, 100)
            },
            curseforge: {
              categoryId: options.type ? cfTypeMap[options.type] : undefined,
              gameVersion: options.version, sortField: options.cfs, index: effectiveOffset, sortOrder: options.cfo,
              modLoaderType: options.cfl ? cfLoaderMap[options.cfl] : undefined,
              pageSize: options.limit ? Math.min(options.limit, 50) : undefined
            },
            mcmod: { type: options.type },
            mcwiki: { limit: options.limit || config.searchResults }
          };
          // 执行搜索
          const resultsByPlatform = {};
          await Promise.all(
            platformsToSearch.map(async p => {
              const platform = PLATFORMS[p];
              if (!platform?.checkConfig(config)) return;
              try {
                const projects = await platform.search(ctx, keyword, config, platformOptions[p] || {});
                const transformed = projects.map(platform.transform);
                if (transformed.length > 0) resultsByPlatform[p] = transformed;
              } catch (error) {
                ctx.logger.error(`${platform.name} 搜索失败:`, error);
              }
            })
          );
          // 检查结果
          if (Object.keys(resultsByPlatform).length === 0) {
            const platformNames = platformsToSearch.map(p => PLATFORMS[p]?.name || p).join('、');
            return `未找到匹配结果：${platformNames}${options.type ? `，类型: ${options.type}` : ''}${options.version ? `，版本: ${options.version}` : ''}`;
          }
          // 处理搜索结果
          const filtered = {};
          for (const platform in resultsByPlatform) {
            let results = resultsByPlatform[platform];
            if (options.version && platform === 'mcmod') results = results.filter(item => !item.extra?.mcversion || item.extra.mcversion.includes(options.version));
            if (options.type) {
              if (platform === 'modrinth') {
                const validTypes = ['mod', 'modpack', 'resourcepack', 'shader'];
                if (validTypes.includes(options.type)) results = results.filter(item => item.extra?.type === options.type);
              } else if (platform === 'mcmod') {
                results = results.filter(item => !item.extra?.type || item.extra.type.toLowerCase().includes(options.type.toLowerCase()));
              }
            }
            if (results.length > 0) filtered[platform] = results;
          }
          // 检查过滤后的结果
          cachedResults = [];
          let hasMore = true;
          for (let i = 0; hasMore; i++) {
            hasMore = false;
            for (const platform in filtered) {
              if (i < filtered[platform].length) {
                cachedResults.push(filtered[platform][i]);
                hasMore = true;
              }
            }
          }
          // 缓存搜索结果
          searchResultsCache.set(sessionId, { results: cachedResults, keyword, page: currentPage, options: { ...options } });
        }
        const searchData = searchResultsCache.get(sessionId);
        const { results, page } = searchData;
        // 处理分页
        const startIndex = 0;
        const endIndex = Math.min(startIndex + config.searchResults, results.length);
        const currentPageResults = results.slice(startIndex, endIndex);
        const hasNextPage = endIndex < results.length;
        // 格式化结果列表
        let promptText = '请回复序号查看详情';
        if (hasNextPage) promptText += '或输入"n"查看下页';
        const formattedResults = [promptText].concat(
          currentPageResults.map((p, i) => {
            const desc = config.searchDesc > 0 && p.description
              ? `\n  ${p.description.substring(0, config.searchDesc)}${p.description.length > config.searchDesc ? '...' : ''}`
              : '';
            return `${i + 1}. [${p.platform}] ${p.name}${desc}`;
          })
        );
        if (page > 0 || hasNextPage) formattedResults.push(`--- 第 ${page + 1} 页 ${hasNextPage ? '(还有更多)' : '(已到最后)'} ---`);
        // 发送搜索结果并等待用户响应
        await renderOutput(session, formattedResults, null, ctx, config, false);
        const choice = await session.prompt(60 * 1000);
        if (!choice) return '操作超时，已取消';
        // 处理用户选择
        if (choice.toLowerCase() === 'n') {
          if (hasNextPage) {
            searchData.page++;
            searchResultsCache.set(sessionId, searchData);
            return await session.execute(`mc.search ${keyword}`);
          } else {
            const newOffset = (page + 1) * config.searchResults;
            return await session.execute(`mc.search ${keyword} -o ${newOffset}`);
          }
        }
        const choiceNum = parseInt(choice);
        if (isNaN(choiceNum) || choiceNum < 1 || choiceNum > currentPageResults.length) {
          return `请输入 1-${currentPageResults.length} 之间的数字${hasNextPage ? '或输入"n"查看下页' : ''}`;
        }
        // 获取详情
        const selected = currentPageResults[choiceNum - 1];
        const platform = Object.values(PLATFORMS).find(p => p.name === selected.platform);
        const detailId = selected.platform === 'MCMOD' ? selected : selected.extra.id;
        const detail = await platform?.getDetail(ctx, detailId, config);
        if (!detail) return '获取详情失败，请重试';
        return renderOutput(session, detail.content, detail.url, ctx, config, options.shot);
      } catch (error) {
        ctx.logger.error('搜索执行失败:', error);
        return '搜索过程出错';
      }
    });
}