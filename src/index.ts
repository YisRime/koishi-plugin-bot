/**
 * 回声洞插件 - 主文件
 * @module best-cave
 * @description 提供回声洞功能的Koishi插件,支持文本、图片、视频投稿与管理
 */

// 导入核心依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';
import {} from 'koishi-plugin-adapter-onebot'

// 基础定义
export const name = 'best-cave';
export const inject = ['database'];

/**
 * 插件配置模式定义
 * @description 定义插件的所有配置项及其验证规则
 * manager: 管理员用户ID列表
 * blacklist: 黑名单用户ID列表
 * whitelist: 白名单用户ID列表(可跳过审核)
 * number: 命令冷却时间(秒)
 * enableAudit: 是否启用投稿审核
 * allowVideo: 是否允许视频投稿
 * videoMaxSize: 视频文件大小限制(MB)
 * imageMaxSize: 图片文件大小限制(MB)
 * enablePagination: 是否启用分页显示
 * itemsPerPage: 每页显示条目数
 */
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required(),
  blacklist: Schema.array(Schema.string()).default([]),
  whitelist: Schema.array(Schema.string()).default([]),
  number: Schema.number().default(60),
  enableAudit: Schema.boolean().default(false),
  allowVideo: Schema.boolean().default(true),
  videoMaxSize: Schema.number().default(16),
  imageMaxSize: Schema.number().default(4),
  enablePagination: Schema.boolean().default(false),
  itemsPerPage: Schema.number().default(10),
}).i18n({
  'zh-CN': require('./locales/zh-CN')._config,
  'en-US': require('./locales/en-US')._config,
});

/**
 * 主插件入口
 * @param ctx Koishi上下文,提供各种API接口
 * @param config 插件配置对象
 * @description 初始化插件环境,注册命令与处理函数
 */
export async function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
  ctx.i18n.define('en-US', require('./locales/en-US'));

  // 初始化路径和冷却管理
  const dataDir = path.join(ctx.baseDir, 'data');
  const caveDir = path.join(dataDir, 'cave');
  const caveFilePath = path.join(caveDir, 'cave.json');
  const resourceDir = path.join(caveDir, 'resources');
  const pendingFilePath = path.join(caveDir, 'pending.json');

  await FileHandler.ensureDirectory(dataDir);
  await FileHandler.ensureDirectory(caveDir);
  await FileHandler.ensureDirectory(resourceDir);
  await FileHandler.ensureJsonFile(caveFilePath);
  await FileHandler.ensureJsonFile(pendingFilePath);

  const idManager = new IdManager(ctx.baseDir);
  await idManager.initialize(caveFilePath, pendingFilePath);

  const lastUsed = new Map<string, number>();

  /**
   * 处理列表查询
   * @param caveFilePath cave数据文件路径
   * @param session 会话上下文
   * @param content 命令内容
   * @param options 命令选项
   * @param config 插件配置
   * @returns 格式化的列表信息
   * @description 统计每个用户的投稿数量并生成报告
   */
  async function processList(
    caveFilePath: string,
    session: any,
    content: string[],
    options: any,
    config: Config
  ): Promise<string> {
    const caveData = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    const caveDir = path.dirname(caveFilePath);
    const stats: Record<string, number[]> = {};

    // 处理 cave 数据,收集统计信息
    for (const cave of caveData) {
      if (cave.contributor_number === '10000') continue;
      if (!stats[cave.contributor_number]) stats[cave.contributor_number] = [];
      stats[cave.contributor_number].push(cave.cave_id);
    }

    const statData = { stats };
    const statFilePath = path.join(caveDir, 'stat.json');
    await fs.promises.writeFile(statFilePath, JSON.stringify(statData, null, 2), 'utf8');

    const lines: string[] = Object.entries(stats).map(([cid, ids]) => {
      return session.text('commands.cave.list.totalItems', [cid, ids.length]) + '\n' +
             session.text('commands.cave.list.idsLine', [ids.join(',')]);
    });
    const totalSubmissions = Object.values(stats).reduce((sum, arr) => sum + arr.length, 0);
    if (config.enablePagination) {
      const itemsPerPage = config.itemsPerPage;
      const totalPages = Math.max(1, Math.ceil(lines.length / itemsPerPage));
      let query = (content[0] || String(options.l) || '').trim();
      let pageNum = parseInt(query, 10);
      if (isNaN(pageNum) || pageNum < 1) pageNum = 1;
      if (pageNum > totalPages) pageNum = totalPages;
      const start = (pageNum - 1) * itemsPerPage;
      const paginatedLines = lines.slice(start, start + itemsPerPage);
      return session.text('commands.cave.list.header', [totalSubmissions]) + '\n' +
             paginatedLines.join('\n') + '\n' +
             session.text('commands.cave.list.pageInfo', [pageNum, totalPages]);
    } else {
      return session.text('commands.cave.list.header', [totalSubmissions]) + '\n' +
             lines.join('\n');
    }
  }

  /**
   * 处理审核操作
   * @description 处理单条或批量审核请求
   * @param ctx Koishi上下文
   * @param pendingFilePath 待审核文件路径
   * @param caveFilePath cave数据文件路径
   * @param resourceDir 资源目录
   * @param session 会话上下文
   * @param options 命令选项
   * @param content 命令内容
   * @returns 审核结果消息
   */
  async function processAudit(
    ctx: Context,
    pendingFilePath: string,
    caveFilePath: string,
    resourceDir: string,
    session: any,
    options: any,
    content: string[]
  ): Promise<string> {
    const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);
    const isApprove = Boolean(options.p);
    if ((options.p === true && content[0] === 'all') ||
        (options.d === true && content[0] === 'all')) {
      return await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session);
    }
    const id = parseInt(content[0] ||
      (typeof options.p === 'string' ? options.p : '') ||
      (typeof options.d === 'string' ? options.d : ''));
    if (isNaN(id)) {
      return sendMessage(session, 'commands.cave.error.invalidId', [], true);
    }
    return sendMessage(session, await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session, id), [], true);
  }

  async function processView(
    caveFilePath: string,
    resourceDir: string,
    session: any,
    options: any,
    content: string[]
  ): Promise<string> {
    const caveId = parseInt(content[0] || (typeof options.g === 'string' ? options.g : ''));
    if (isNaN(caveId)) return sendMessage(session, 'commands.cave.error.invalidId', [], true);
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    const cave = data.find(item => item.cave_id === caveId);
    if (!cave) return sendMessage(session, 'commands.cave.error.notFound', [], true);
    return buildMessage(cave, resourceDir, session);
  }

  async function processRandom(
    caveFilePath: string,
    resourceDir: string,
    session: any,
    config: Config
  ): Promise<string | void> {
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    if (data.length === 0) {
      return sendMessage(session, 'commands.cave.error.noCave', [], true);
    }

    const guildId = session.guildId;
    const now = Date.now();
    const lastTime = lastUsed.get(guildId) || 0;
    const isManager = config.manager.includes(session.userId);

    if (!isManager && now - lastTime < config.number * 1000) {
      const waitTime = Math.ceil((config.number * 1000 - (now - lastTime)) / 1000);
      return sendMessage(session, 'commands.cave.message.cooldown', [waitTime], true);
    }

    lastUsed.set(guildId, now);

    const cave = (() => {
      const validCaves = data.filter(cave => cave.elements && cave.elements.length > 0);
      if (!validCaves.length) return undefined;
      const randomIndex = Math.floor(Math.random() * validCaves.length);
      return validCaves[randomIndex];
    })();

    return cave ? buildMessage(cave, resourceDir, session)
                : sendMessage(session, 'commands.cave.error.getCave', [], true);
  }

  async function processDelete(
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    config: Config,
    options: any,
    content: string[]
  ): Promise<string> {
    const caveId = parseInt(content[0] || (typeof options.r === 'string' ? options.r : ''));
    if (isNaN(caveId)) return sendMessage(session, 'commands.cave.error.invalidId', [], true);

    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);

    // 根据 cave_id 查找而不是索引查找
    const targetInData = data.find(item => item.cave_id === caveId);
    const targetInPending = pendingData.find(item => item.cave_id === caveId);

    if (!targetInData && !targetInPending) {
      return sendMessage(session, 'commands.cave.error.notFound', [], true);
    }

    const targetCave = targetInData || targetInPending;
    const isPending = !targetInData;

    // 权限检查
    if (targetCave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
      return sendMessage(session, 'commands.cave.remove.noPermission', [], true);
    }

    // 先生成回声洞预览消息
    const caveContent = await buildMessage(targetCave, resourceDir, session);

    // 删除相关的媒体文件
    if (targetCave.elements) {
      for (const element of targetCave.elements) {
        if ((element.type === 'img' || element.type === 'video') && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
          }
        }
      }
    }

    // 从数组中移除目标对象（使用 filter 而不是 splice）
    if (isPending) {
      const newPendingData = pendingData.filter(item => item.cave_id !== caveId);
      await FileHandler.writeJsonData(pendingFilePath, newPendingData);
    } else {
      const newData = data.filter(item => item.cave_id !== caveId);
      await FileHandler.writeJsonData(caveFilePath, newData);
    }

    // 标记 ID 为已删除
    await idManager.markDeleted(caveId);

    const deleteStatus = isPending
      ? session.text('commands.cave.remove.deletePending')
      : '';
    const deleteMessage = session.text('commands.cave.remove.deleted');
    return `${deleteMessage}${deleteStatus}${caveContent}`;
  }

  async function processAdd(
    ctx: Context,
    config: Config,
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    content: string[]
  ): Promise<string> {
    try {
      // 内联 getInputWithTimeout
      const inputContent = content.length > 0 ? content.join('\n') : await (async () => {
        await sendMessage(session, 'commands.cave.add.noContent', [], true);
        const reply = await session.prompt({ timeout: 60000 });
        if (!reply) throw new Error(session.text('commands.cave.add.operationTimeout'));
        return reply;
      })();

      const caveId = await idManager.getNextId();

      if (inputContent.includes('/app/.config/QQ/')) {
        return sendMessage(session, 'commands.cave.add.localFileNotAllowed', [], true);
      }

      // 内联 checkBypassAudit
      const bypassAudit = config.whitelist.includes(session.userId) ||
                         config.whitelist.includes(session.guildId) ||
                         config.whitelist.includes(session.channelId);

      const { imageUrls, imageElements, videoUrls, videoElements, textParts } =
        await extractMediaContent(inputContent, config, session);

      if (videoUrls.length > 0 && !config.allowVideo) {
        return sendMessage(session, 'commands.cave.add.videoDisabled', [], true);
      }

      const [savedImages, savedVideos] = await Promise.all([
        imageUrls.length > 0 ? saveMedia(
          imageUrls,
          imageElements.map(el => el.fileName),
          resourceDir,
          caveId,
          'img',
          ctx,
          session
        ) : [],
        videoUrls.length > 0 ? saveMedia(
          videoUrls,
          videoElements.map(el => el.fileName),
          resourceDir,
          caveId,
          'video',
          ctx,
          session
        ) : []
      ]);

      // 内联 buildCaveObject
      const newCave: CaveObject = {
        cave_id: caveId,
        elements: [
          ...textParts,
          ...imageElements.map((el, idx) => ({ ...el, file: savedImages[idx] }))
        ].sort((a, b) => a.index - b.index)
         .map(element => {
           if (element.type === 'text') {
             return { type: 'text' as const, content: element.content, index: element.index };
           }
           return { type: element.type, file: element.file, index: element.index };
         }),
        contributor_number: session.userId,
        contributor_name: session.username
      };

      // 如果有视频，直接添加到elements末尾
      if (videoUrls.length > 0 && savedVideos.length > 0) {
        newCave.elements.push({
          type: 'video',
          file: savedVideos[0],
          index: Number.MAX_SAFE_INTEGER
        });
      }

      // 处理审核逻辑
      if (config.enableAudit && !bypassAudit) {
        const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);
        pendingData.push(newCave);
        await Promise.all([
          FileHandler.writeJsonData(pendingFilePath, pendingData),
          sendAuditMessage(ctx, config, newCave, await buildMessage(newCave, resourceDir, session), session)
        ]);
        return sendMessage(session, 'commands.cave.add.submitPending', [caveId], false);
      }

      // 7. 直接保存
      const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
      data.push(newCave);
      await FileHandler.writeJsonData(caveFilePath, data);
      return sendMessage(session, 'commands.cave.add.addSuccess', [caveId], false);

    } catch (error) {
      logger.error(`Failed to process add command: ${error.message}`);
      return sendMessage(session, `commands.cave.error.${error.code || 'unknown'}`, [], true);
    }
  }

  // 合并审核相关函数
  async function handleAudit(
    ctx: Context,
    pendingData: PendingCave[],
    isApprove: boolean,
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    targetId?: number
  ): Promise<string> {
    if (pendingData.length === 0) {
      return sendMessage(session, 'commands.cave.audit.noPending', [], true);
    }

    // 处理单条审核
    if (typeof targetId === 'number') {
      const targetCave = pendingData.find(item => item.cave_id === targetId);
      if (!targetCave) {
        return sendMessage(session, 'commands.cave.audit.pendingNotFound', [], true);
      }

      const newPendingData = pendingData.filter(item => item.cave_id !== targetId);

      if (isApprove) {
        const oldCaveData = await FileHandler.readJsonData<CaveObject>(caveFilePath);
        const newCaveData = [...oldCaveData, {
          ...targetCave,
          elements: cleanElementsForSave(targetCave.elements)
        }];

        await FileHandler.withTransaction([
          {
            filePath: caveFilePath,
            operation: async () => FileHandler.writeJsonData(caveFilePath, newCaveData),
            rollback: async () => FileHandler.writeJsonData(caveFilePath, oldCaveData)
          },
          {
            filePath: pendingFilePath,
            operation: async () => FileHandler.writeJsonData(pendingFilePath, newPendingData),
            rollback: async () => FileHandler.writeJsonData(pendingFilePath, pendingData)
          }
        ]);
      } else {
        await FileHandler.writeJsonData(pendingFilePath, newPendingData);
        // 删除关联的媒体文件
        if (targetCave.elements) {
          for (const element of targetCave.elements) {
            if ((element.type === 'img' || element.type === 'video') && element.file) {
              const fullPath = path.join(resourceDir, element.file);
              if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
              }
            }
          }
        }
      }

      const remainingCount = newPendingData.length;
      if (remainingCount > 0) {
        const remainingIds = newPendingData.map(c => c.cave_id).join(', ');
        const action = isApprove ? 'auditPassed' : 'auditRejected';
        return sendMessage(session, 'commands.cave.audit.pendingResult', [
          session.text(`commands.cave.audit.${action}`),
          remainingCount,
          remainingIds
        ], false);
      }
      return sendMessage(
        session,
        isApprove ? 'commands.cave.audit.auditPassed' : 'commands.cave.audit.auditRejected',
        [],
        false
      );
    }

    // 处理批量审核
    const data = isApprove ? await FileHandler.readJsonData<CaveObject>(caveFilePath) : null;
    let processedCount = 0;

    if (isApprove && data) {
      const oldData = [...data];
      const newData = [...data];

      await FileHandler.withTransaction([
        {
          filePath: caveFilePath,
          operation: async () => {
            for (const cave of pendingData) {
              newData.push({
                ...cave,
                elements: cleanElementsForSave(cave.elements)
              });
              processedCount++;
            }
            return FileHandler.writeJsonData(caveFilePath, newData);
          },
          rollback: async () => FileHandler.writeJsonData(caveFilePath, oldData)
        },
        {
          filePath: pendingFilePath,
          operation: async () => FileHandler.writeJsonData(pendingFilePath, []),
          rollback: async () => FileHandler.writeJsonData(pendingFilePath, pendingData)
        }
      ]);
    } else {
      await FileHandler.writeJsonData(pendingFilePath, []);
      // 删除所有被拒绝投稿的媒体文件
      for (const cave of pendingData) {
        if (cave.elements) {
          for (const element of cave.elements) {
            if ((element.type === 'img' || element.type === 'video') && element.file) {
              const fullPath = path.join(resourceDir, element.file);
              if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
              }
            }
          }
        }
        processedCount++;
      }
    }

    return sendMessage(session, 'commands.cave.audit.batchAuditResult', [
      isApprove ? '通过' : '拒绝',
      processedCount,
      pendingData.length
    ], false);
  }

  // 注册命令并配置权限检查
  ctx.command('cave [message]')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })
    .option('l', '查询投稿统计', { type: 'string' })
    .before(async ({ session, options }) => {
      // 黑名单检查
      if (config.blacklist.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.blacklisted', [], true);
      }
      if ((options.l || options.p || options.d) && !config.manager.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.managerOnly', [], true);
      }
    })
    .action(async ({ session, options }, ...content) => {
      const dataDir = path.join(ctx.baseDir, 'data');
      const caveDir = path.join(dataDir, 'cave');
      const caveFilePath = path.join(caveDir, 'cave.json');
      const resourceDir = path.join(caveDir, 'resources');
      const pendingFilePath = path.join(caveDir, 'pending.json');

      if (options.l !== undefined) {
        return await processList(caveFilePath, session, content, options, config);
      }
      if (options.p || options.d) {
        return await processAudit(ctx, pendingFilePath, caveFilePath, resourceDir, session, options, content);
      }
      if (options.g) {
        return await processView(caveFilePath, resourceDir, session, options, content);
      }
      if (options.r) {
        return await processDelete(caveFilePath, resourceDir, pendingFilePath, session, config, options, content);
      }
      if (options.a) {
        return await processAdd(ctx, config, caveFilePath, resourceDir, pendingFilePath, session, content);
      }
      return await processRandom(caveFilePath, resourceDir, session, config);
    });
}

// 日志记录器
const logger = new Logger('cave');

// 接口定义
export interface User { userId: string; username: string; nickname?: string; }
export interface getStrangerInfo { user_id: string; nickname: string; }
export interface Config {
  manager: string[];
  number: number;
  enableAudit: boolean;
  allowVideo: boolean;
  videoMaxSize: number;
  imageMaxSize: number;
  blacklist: string[];
  whitelist: string[];
  enablePagination: boolean;
  itemsPerPage: number;
}

// 定义数据类型接口
interface BaseElement { type: 'text' | 'img' | 'video'; index: number }
interface TextElement extends BaseElement { type: 'text'; content: string }
interface MediaElement extends BaseElement { type: 'img' | 'video'; file?: string; fileName?: string; fileSize?: string; filePath?: string }
type Element = TextElement | MediaElement;

interface CaveObject { cave_id: number; elements: Element[]; contributor_number: string; contributor_name: string }
interface PendingCave extends CaveObject {}

/**
 * 文件处理工具类
 */
class FileHandler {
  private static locks = new Map<string, Promise<any>>();
  private static readonly RETRY_COUNT = 3;
  private static readonly RETRY_DELAY = 1000;
  private static readonly CONCURRENCY_LIMIT = 5;

  /**
   * 并发控制
   */
  private static async withConcurrencyLimit<T>(
    operation: () => Promise<T>,
    limit = this.CONCURRENCY_LIMIT
  ): Promise<T> {
    while (this.locks.size >= limit) {
      await Promise.race(this.locks.values());
    }
    return operation();
  }

  /**
   * 统一的文件操作包装器
   */
  private static async withFileOp<T>(
    filePath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = filePath;

    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    const operationPromise = (async () => {
      for (let i = 0; i < this.RETRY_COUNT; i++) {
        try {
          return await operation();
        } catch (error) {
          if (i === this.RETRY_COUNT - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
        }
      }
      throw new Error('Operation failed after retries');
    })();

    this.locks.set(key, operationPromise);
    try {
      return await operationPromise;
    } finally {
      this.locks.delete(key);
    }
  }

  /**
   * 事务处理
   */
  static async withTransaction<T>(
    operations: Array<{
      filePath: string;
      operation: () => Promise<T>;
      rollback?: () => Promise<void>;
    }>
  ): Promise<T[]> {
    const results: T[] = [];
    const completed = new Set<string>();

    try {
      for (const {filePath, operation} of operations) {
        const result = await this.withFileOp(filePath, operation);
        results.push(result);
        completed.add(filePath);
      }
      return results;
    } catch (error) {
      // 并行执行所有回滚操作
      await Promise.all(
        operations
          .filter(({filePath}) => completed.has(filePath))
          .map(async ({filePath, rollback}) => {
            if (rollback) {
              await this.withFileOp(filePath, rollback).catch(e =>
                logger.error(`Rollback failed for ${filePath}: ${e.message}`)
              );
            }
          })
      );
      throw error;
    }
  }

  /**
   * JSON文件读写
   */
  static async readJsonData<T>(filePath: string): Promise<T[]> {
    return this.withFileOp(filePath, async () => {
      try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(data || '[]');
      } catch (error) {
        return [];
      }
    });
  }

  static async writeJsonData<T>(filePath: string, data: T[]): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    await this.withFileOp(filePath, async () => {
      await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2));
      await fs.promises.rename(tmpPath, filePath);
    });
  }

  /**
   * 文件系统操作
   */
  static async ensureDirectory(dir: string): Promise<void> {
    await this.withConcurrencyLimit(async () => {
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
    });
  }

  static async ensureJsonFile(filePath: string): Promise<void> {
    await this.withFileOp(filePath, async () => {
      if (!fs.existsSync(filePath)) {
        await fs.promises.writeFile(filePath, '[]', 'utf8');
      }
    });
  }

  /**
   * 媒体文件操作
   */
  static async saveMediaFile(
    filePath: string,
    data: Buffer | string
  ): Promise<void> {
    await this.withConcurrencyLimit(async () => {
      const dir = path.dirname(filePath);
      await this.ensureDirectory(dir);
      await this.withFileOp(filePath, () =>
        fs.promises.writeFile(filePath, data)
      );
    });
  }

  static async deleteMediaFile(filePath: string): Promise<void> {
    await this.withFileOp(filePath, async () => {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    });
  }
}

/**
 * ID管理器
 * @description 负责cave ID的分配、回收和持久化
 */
class IdManager {
  private deletedIds: Set<number> = new Set();
  private maxId: number = 0;
  private initialized: boolean = false;
  private readonly idFilePath: string;
  private static readonly MAX_DELETED_IDS = 10000;

  constructor(baseDir: string) {
    this.idFilePath = path.join(baseDir, 'data', 'cave', 'id.json');
  }

  async initialize(caveFilePath: string, pendingFilePath: string) {
    if (this.initialized) return;

    try {
      // 读取现有状态
      const idData = fs.existsSync(this.idFilePath) ?
        JSON.parse(await fs.promises.readFile(this.idFilePath, 'utf8')) :
        { deletedIds: [], maxId: 0, lastUpdated: new Date().toISOString() };

      // 加载数据
      const [caveData, pendingData] = await Promise.all([
        FileHandler.readJsonData<CaveObject>(caveFilePath),
        FileHandler.readJsonData<PendingCave>(pendingFilePath)
      ]);

      // 计算已使用的ID
      const usedIds = new Set([
        ...caveData.map(item => item.cave_id),
        ...pendingData.map(item => item.cave_id)
      ]);

      // 更新状态
      const caveMaxId = usedIds.size > 0 ? Math.max(...Array.from(usedIds)) : 0;
      this.maxId = Math.max(caveMaxId, idData.maxId || 0);

      // 重新生成已删除ID列表
      this.deletedIds = new Set(
        Array.from({length: this.maxId}, (_, i) => i + 1)
          .filter(id => !usedIds.has(id))
      );

      await this.saveIds();
      this.initialized = true;

    } catch (error) {
      logger.error(`IdManager initialization failed: ${error.message}`);
      throw error;
    }
  }

  getNextId(): number {
    if (this.deletedIds.size === 0) {
      return ++this.maxId;
    }
    const nextId = Math.min(...Array.from(this.deletedIds));
    this.deletedIds.delete(nextId);
    this.saveIds().catch(err => logger.error(`Failed to save ID state: ${err.message}`));
    return nextId;
  }

  async markDeleted(id: number) {
    if (id > 0 && id <= this.maxId) {
      this.deletedIds.add(id);
      if (id === this.maxId) {
        while (this.deletedIds.has(this.maxId)) {
          this.deletedIds.delete(this.maxId--);
        }
      }
      if (this.deletedIds.size >= IdManager.MAX_DELETED_IDS) {
        // 清理过期ID
        const oldestIds = Array.from(this.deletedIds).slice(0, 1000);
        oldestIds.forEach(id => this.deletedIds.delete(id));
      }
      await this.saveIds();
    }
  }

  private async saveIds(): Promise<void> {
    const data = {
      deletedIds: Array.from(this.deletedIds),
      maxId: this.maxId,
      lastUpdated: new Date().toISOString()
    };
    await fs.promises.writeFile(this.idFilePath, JSON.stringify(data, null, 2), 'utf8');
  }
}

/**
 * 发送消息
 * @param session 会话上下文
 * @param key 消息key
 * @param params 消息参数
 * @param isTemp 是否为临时消息
 * @param timeout 临时消息超时时间
 */
async function sendMessage(
  session: any,
  key: string,
  params: any[] = [],
  isTemp = true,
  timeout = 10000
): Promise<string> {
  try {
    const msg = await session.send(session.text(key, params));
    if (isTemp && msg) {
      setTimeout(async () => {
        try {
          await session.bot.deleteMessage(session.channelId, msg);
        } catch (error) {
          logger.debug(`Failed to delete temporary message: ${error.message}`);
        }
      }, timeout);
    }
  } catch (error) {
    logger.error(`Failed to send message: ${error.message}`);
  }
  return '';
}

/**
 * 审核相关功能
 */
// 发送审核消息给管理员
async function sendAuditMessage(ctx: Context, config: Config, cave: PendingCave, content: string, session: any) {
  const auditMessage = `${session.text('commands.cave.audit.title')}\n${content}
${session.text('commands.cave.audit.from')}${cave.contributor_number}`;

  for (const managerId of config.manager) {
    const bot = ctx.bots[0];
    if (bot) {
      try {
        await bot.sendPrivateMessage(managerId, auditMessage);
      } catch (error) {
        logger.error(session.text('commands.cave.audit.sendFailed', [managerId]));
      }
    }
  }
}

/**
 * 消息构建工具
 */
// 清理元素数据用于保存
function cleanElementsForSave(elements: Element[]): Element[] {
  if (!elements?.length) return [];

  const cleanedElements = elements.map(element => {
    if (element.type === 'text') {
      return { type: 'text' as const, index: element.index, content: (element as TextElement).content } as TextElement;
    } else if (element.type === 'img' || element.type === 'video') {
      const mediaElement = element as MediaElement;
      if (mediaElement.file) {
        return { type: mediaElement.type, index: element.index, file: mediaElement.file } as MediaElement;
      } else {
        return { type: mediaElement.type, index: element.index } as MediaElement;
      }
    }
    return element;
  });
  return cleanedElements.sort((a, b) => a.index - b.index);
}

// 处理媒体文件
async function processMediaFile(filePath: string, type: 'image' | 'video'): Promise<string | null> {
  const data = await fs.promises.readFile(filePath).catch(() => null);
  if (!data) return null;
  return `data:${type}/${type === 'image' ? 'png' : 'mp4'};base64,${data.toString('base64')}`;
}

// 构建消息内容
async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  if (!cave?.elements?.length) {
    return session.text('commands.cave.error.noContent');
  }

  // 分离视频元素和其他元素
  const videoElement = cave.elements.find((el): el is MediaElement => el.type === 'video');
  const nonVideoElements = cave.elements.filter(el => el.type !== 'video');

  // 如果有视频元素，先发送基本信息，然后单独发送视频
  if (videoElement?.file) {
    // 构建基本信息
    const basicInfo = [
    session.text('commands.cave.message.caveTitle', [cave.cave_id]),
    session.text('commands.cave.message.contributorSuffix', [cave.contributor_name])
    ].join('\n');

    // 先发送标题和作者信息
    await session?.send(basicInfo);

    // 发送视频
    const filePath = path.join(resourceDir, videoElement.file);
    const base64Data = await processMediaFile(filePath, 'video');
    if (base64Data && session) {
      await session.send(h('video', { src: base64Data }));
    }
    return ''; // 返回空字符串因为消息已经发送
  }

  // 如果没有视频，按原来的方式处理
  const lines = [session.text('commands.cave.message.caveTitle', [cave.cave_id])];

  for (const element of nonVideoElements) {
    if (element.type === 'text') {
      lines.push(element.content);
    } else if (element.type === 'img' && element.file) {
      const filePath = path.join(resourceDir, element.file);
      const base64Data = await processMediaFile(filePath, 'image');
      if (base64Data) {
        lines.push(h('image', { src: base64Data }));
      }
    }
  }

  lines.push(session.text('commands.cave.message.contributorSuffix', [cave.contributor_name]));
  return lines.join('\n');
}

/**
 * 媒体处理相关函数
 */

/**
 * 提取媒体内容
 * @description 从原始内容中提取文本、图片和视频元素
 * @param originalContent 原始内容字符串
 * @param config 插件配置
 * @returns 分类后的媒体元素
 * - imageUrls: 图片URL列表
 * - imageElements: 图片元素对象列表
 * - videoUrls: 视频URL列表
 * - videoElements: 视频元素对象列表
 * - textParts: 文本元素列表
 */
async function extractMediaContent(originalContent: string, config: Config, session: any): Promise<{
  imageUrls: string[],
  imageElements: Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>,
  videoUrls: string[],
  videoElements: Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>,
  textParts: Element[]
}> {
  const textParts = originalContent
    .split(/<(img|video)[^>]+>/)
    .map((text, idx) => text.trim() && ({
      type: 'text' as const,
      content: text.replace(/^(img|video)$/, '').trim(),
      index: idx * 3
    }))
    .filter(text => text && text.content);

  const getMediaElements = (type: 'img' | 'video', maxSize: number) => {
    const regex = new RegExp(`<${type}[^>]+src="([^"]+)"[^>]*>`, 'g');
    const elements: Array<{ type: typeof type; index: number; fileName?: string; fileSize?: string }> = [];
    const urls: string[] = [];

    let match;
    let idx = 0;
    while ((match = regex.exec(originalContent)) !== null) {
      const element = match[0];
      const url = match[1];
      const fileName = element.match(/file="([^"]+)"/)?.[1];
      const fileSize = element.match(/fileSize="([^"]+)"/)?.[1];

      // 提前检查文件大小
      if (fileSize) {
        const sizeInBytes = parseInt(fileSize);
        if (sizeInBytes > maxSize * 1024 * 1024) {
          throw new Error(session.text('commands.cave.message.mediaSizeExceeded', [type]));
        }
      }

      urls.push(url);
      elements.push({
        type,
        index: idx * 3 + (type === 'img' ? 1 : 2),
        fileName,
        fileSize
      });
      idx++;
    }
    return { urls, elements };
  };

  // 分别检查图片和视频
  const { urls: imageUrls, elements: imageElementsRaw } = getMediaElements('img', config.imageMaxSize);
  const imageElements = imageElementsRaw as Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>;
  const { urls: videoUrls, elements: videoElementsRaw } = getMediaElements('video', config.videoMaxSize);
  const videoElements = videoElementsRaw as Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>;

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
}

/**
 * 保存媒体文件
 * @description 下载并保存媒体文件到本地
 * @param urls 媒体文件URL列表
 * @param fileNames 文件名列表
 * @param resourceDir 资源目录
 * @param caveId 回声洞ID
 * @param mediaType 媒体类型(img/video)
 * @param ctx Koishi上下文
 * @param session 会话上下文
 * @returns 保存后的文件名列表
 */
async function saveMedia(
  urls: string[],
  fileNames: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  mediaType: 'img' | 'video',
  ctx: Context,
  session: any
): Promise<string[]> {
  const { ext, accept } = mediaType === 'img'
    ? { ext: 'png', accept: 'image/*' }
    : { ext: 'mp4', accept: 'video/*' };

  const downloadTasks = urls.map(async (url, i) => {
    const fileName = fileNames[i];
    const fileExt = fileName?.match(/\.[a-zA-Z0-9]+$/)?.[0]?.slice(1) || ext;
    const baseName = fileName
      ? path.basename(fileName, path.extname(fileName)).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
      : String(i + 1);
    const finalFileName = `${caveId}_${baseName}.${fileExt}`;
    const filePath = path.join(resourceDir, finalFileName);

    try {
      const response = await ctx.http(decodeURIComponent(url).replace(/&amp;/g, '&'), {
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': accept,
          'Referer': 'https://qq.com'
        }
      });

      if (!response.data) throw new Error('empty_response');

      await FileHandler.saveMediaFile(filePath, Buffer.from(response.data));
      return finalFileName;
    } catch (error) {
      logger.error(`Failed to download media: ${error.message}`);
      throw error;
    }
  });

  const results = await Promise.allSettled(downloadTasks);
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
    .map(result => result.value);

  if (!successfulResults.length) {
    throw new Error(session.text(`commands.cave.error.upload${mediaType === 'img' ? 'Image' : 'Video'}Failed`));
  }

  return successfulResults;
}
