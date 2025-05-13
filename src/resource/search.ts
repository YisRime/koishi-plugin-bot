import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { PLATFORMS, CF_MAPS } from './maps'

/**
 * 注册搜索命令
 * @param {Context} ctx - Koishi上下文
 * @param {Command} mc - 父命令对象
 * @param {Config} config - 配置对象
 */
export function registerSearch(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.search <keyword:text>', '搜索 Minecraft 资源')
    .option('mr', '-mr 搜索 Modrinth')
    .option('cf', '-cf 搜索 CurseForge')
    .option('mcmod', '-mod 搜索 MCMOD 百科')
    .option('mcwiki', '-wiki 搜索 Minecraft Wiki')
    .option('shot', '-s 使用截图模式')
    .option('mrs', '-mrs <sort:string> [MR]排序方式')
    .option('mrf', '-mrf <facets:string> [MR]高级过滤')
    .option('cfl', '-cfl <loader:string> [CF]加载器')
    .option('cfs', '-cfs <sort:string> [CF]排序方式')
    .option('cfo', '-cfo <order:string> [CF]升降序')
    .option('version', '-v <version:string> 支持版本')
    .option('skip', '-k <count:number> 跳过结果数')
    .option('type', `-t <type:string> 资源类型(${Object.keys(CF_MAPS.TYPE).join('|')})`)
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      try {
        // 存储按平台分类的搜索结果和平台偏移量
        let platformResults: Record<string, any[]> = {};
        let platformOffsets: Record<string, number> = {};
        // 记录已经没有更多结果的平台
        let exhaustedPlatforms: Record<string, boolean> = {};
        let currentPage = 0;
        let skip = Math.max(0, options.skip || 0);

        // 确定需要搜索的平台
        const platformsToSearch =
          [options.mr && 'modrinth', options.cf && 'curseforge',
           options.mcmod && 'mcmod', options.mcwiki && 'mcwiki']
            .filter(Boolean);
        if (!platformsToSearch.length) platformsToSearch.push('modrinth', 'curseforge');

        // 初始化平台偏移量
        platformsToSearch.forEach(p => {
          platformOffsets[p] = skip;
          platformResults[p] = [];
          exhaustedPlatforms[p] = false;
        });

        // 执行搜索的函数，可指定特定平台
        const executeSearch = async (platforms = platformsToSearch) => {
          // 过滤掉已经确认没有更多结果的平台
          const activePlatforms = platforms.filter(p => !exhaustedPlatforms[p]);
          if (activePlatforms.length === 0) {
            return { success: true }; // 没有可搜索的平台，但这不是错误
          }

          // 参数配置
          const platformOptions = {
            modrinth: {
              facets: options.mrf || (options.type && JSON.stringify([[`project_type:${options.type}`]])),
              sort: options.mrs, version: options.version,
              offset: platformOffsets['modrinth'],
              limit: 100
            },
            curseforge: {
              categoryId: options.type ? CF_MAPS.TYPE[options.type] : undefined,
              gameVersion: options.version,
              modLoaderType: options.cfl ? CF_MAPS.LOADER[options.cfl] : undefined,
              sortField: options.cfs, sortOrder: options.cfo,
              index: platformOffsets['curseforge'],
              pageSize: 50
            },
            mcmod: { type: options.type },
            mcwiki: {}
          }

          // 并行搜索指定平台
          const searchResults = await Promise.all(
            activePlatforms.map(async p => {
              const platform = PLATFORMS[p]
              if (!platform?.checkConfig(config)) return { platform: p, results: [] }
              try {
                const projects = await platform.search(ctx, keyword, config, platformOptions[p] || {})
                const transformedResults = projects.map(platform.transform)

                // 如果此次搜索没有返回结果，标记为已耗尽
                if (transformedResults.length === 0) {
                  exhaustedPlatforms[p] = true;
                } else {
                  // 更新平台偏移量
                  platformOffsets[p] += transformedResults.length;
                }

                return { platform: p, results: transformedResults }
              } catch (error) {
                ctx.logger.error(`${platform.name} 搜索失败:`, error)
                return { platform: p, results: [] }
              }
            })
          )

          // 整理结果并添加到平台结果中
          searchResults.forEach(({ platform, results }) => {
            if (results.length > 0) {
              // 对结果进行过滤
              let filtered = results;

              // 版本过滤
              if (options.version && platform === 'mcmod')
                filtered = filtered.filter(item => !item.extra?.mcversion || item.extra.mcversion.includes(options.version));

              // 类型过滤
              if (options.type) {
                if (platform === 'modrinth') {
                  const validTypes = ['mod', 'modpack', 'resourcepack', 'shader'];
                  if (validTypes.includes(options.type))
                    filtered = filtered.filter(item => item.extra?.type === options.type);
                } else if (platform === 'mcmod') {
                  filtered = filtered.filter(item => !item.extra?.type ||
                    item.extra.type.toLowerCase().includes(options.type.toLowerCase()));
                }
              }

              // 添加过滤后的结果
              platformResults[platform] = platformResults[platform].concat(filtered);
            }
          });

          // 检查是否有任何平台返回结果
          const initialSearch = platformsToSearch.every(p => exhaustedPlatforms[p]) &&
                               Object.values(platformResults).every(results => results.length === 0);

          if (initialSearch) {
            const platformNames = platformsToSearch.map(p => PLATFORMS[p]?.name || p).join('、');
            return {
              success: false,
              message: `未找到匹配的资源：${platformNames}${options.type ? `，类型: ${options.type}` : ''}${options.version ? `，版本: ${options.version}` : ''}`
            }
          }

          return { success: true };
        };

        // 初次搜索
        const initialSearch = await executeSearch();
        if (!initialSearch.success) return initialSearch.message;

        // 处理显示和用户交互的函数
        const handlePage = async () => {
          // 计算当前页显示的起始和结束索引
          const startIndex = currentPage * config.searchResults;
          const endIndex = startIndex + config.searchResults;

          // 合并当前所有平台结果并进行交错排列
          const allResults = [];
          let maxResults = 0;

          for (const platform in platformResults) {
            if (platformResults[platform].length > maxResults) {
              maxResults = platformResults[platform].length;
            }
          }

          for (let i = 0; i < maxResults; i++) {
            for (const platform in platformResults) {
              if (i < platformResults[platform].length) {
                allResults.push(platformResults[platform][i]);
              }
            }
          }

          // 检查是否需要加载更多结果
          if (endIndex > allResults.length) {
            // 确定哪些平台需要加载更多结果
            const platformsToLoad = [];
            for (const platform in platformResults) {
              // 如果平台没有被标记为耗尽且结果数量小于其他平台或总结果接近用尽
              if (!exhaustedPlatforms[platform]) {
                const platformResultCount = platformResults[platform].length;
                if (platformResultCount < maxResults || allResults.length - endIndex < config.searchResults) {
                  platformsToLoad.push(platform);
                }
              }
            }

            // 如果有平台需要且可以加载更多结果
            if (platformsToLoad.length > 0) {
              await executeSearch(platformsToLoad);
              // 重新计算结果
              return await handlePage();
            }
          }

          // 获取当前页的结果
          const currentResults = allResults.slice(startIndex, endIndex);

          // 判断是否有下一页
          // 直接看是否还有结果，不再根据平台结果数猜测是否可能有更多结果
          const hasNextPage = endIndex < allResults.length;

          // 如果没有结果，可能是到达了最后一页
          if (currentResults.length === 0) {
            return '没有更多结果可显示';
          }

          // 格式化结果列表
          const formattedResults = ['请回复序号查看对应详情：']
            .concat(
              currentResults.map((p, i) => {
                const desc = config.searchDesc > 0 && p.description
                  ? `\n  ${p.description.substring(0, config.searchDesc)}${p.description.length > config.searchDesc ? '...' : ''}`
                  : '';
                return `${startIndex + i + 1}. [${p.platform}] ${p.name}${desc}`;
              })
            );

          // 添加分页提示
          if (hasNextPage) formattedResults.push(`\n输入 n 显示下一页 (${currentPage + 2}/${Math.ceil(allResults.length / config.searchResults)})`);
          formattedResults.push('输入 c 取消');

          await renderOutput(session, formattedResults, null, ctx, config, false);

          // 获取用户选择
          const input = await session.prompt(60 * 1000);
          if (!input) return '已超时，请重新搜索';

          // 处理用户输入
          if (input.toLowerCase() === 'c') return '已取消搜索';

          if (input.toLowerCase() === 'n') {
            if (hasNextPage) {
              currentPage++;
              return await handlePage();
            } else {
              return '没有更多结果了';
            }
          }

          // 处理序号选择
          const choice = parseInt(input);
          if (isNaN(choice) || choice < 1 || choice > allResults.length) {
            return `请输入 1-${allResults.length} 之间的数字，或 n 查看下一页，c 取消`;
          }

          // 获取详情
          const selected = allResults[choice - 1];
          const platform = Object.values(PLATFORMS).find(p => p.name === selected.platform);
          const detailId = selected.platform === 'MCMOD' ? selected : selected.extra.id;
          const detail = await platform?.getDetail(ctx, detailId, config);
          if (!detail) return '获取详情失败';

          return renderOutput(session, detail.content, detail.url, ctx, config, options.shot);
        };

        return await handlePage();
      } catch (error) {
        ctx.logger.error('搜索执行失败:', error);
        return '搜索时发生错误，请稍后再试';
      }
    })
}