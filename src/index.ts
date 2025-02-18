// 回声洞插件 - 提供文本、图片、视频的投稿与管理功能

// 导入依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';
import {} from 'koishi-plugin-adapter-onebot'
import { FileHandler } from './utils/fileHandler'
import { IdManager } from './utils/idManager'
import { HashStorage } from './utils/HashStorage'
import { handleAudit, sendAuditMessage } from './utils/auditHandler'
import { extractMediaContent, saveMedia, buildMessage } from './utils/mediaHandler'

// 基础定义
export const name = 'best-cave';
export const inject = ['database'];

/**
 * 插件配置项
 * @type {Schema}
 */
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required(), // 管理员用户ID
  number: Schema.number().default(60),              // 冷却时间(秒)
  enableAudit: Schema.boolean().default(false),     // 启用审核
  imageMaxSize: Schema.number().default(4),         // 图片大小限制(MB)
  enableMD5: Schema.boolean().default(true),        // 启用MD5查重
  enableDuplicate: Schema.boolean().default(true),  // 启用相似度查重
  duplicateThreshold: Schema.number().default(0.8), // 相似度查重阈值(0-1)
  allowVideo: Schema.boolean().default(true),       // 允许视频
  videoMaxSize: Schema.number().default(16),        // 视频大小限制(MB)
  enablePagination: Schema.boolean().default(false),// 启用分页
  itemsPerPage: Schema.number().default(10),        // 每页条数
  blacklist: Schema.array(Schema.string()).default([]), // 黑名单
  whitelist: Schema.array(Schema.string()).default([]), // 白名单
}).i18n({
  'zh-CN': require('./locales/zh-CN')._config,
  'en-US': require('./locales/en-US')._config,
});

/**
 * 插件主入口
 * @param {Context} ctx - Koishi上下文
 * @param {Config} config - 插件配置
 */
export async function apply(ctx: Context, config: Config) {
  // 初始化国际化
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
  ctx.i18n.define('en-US', require('./locales/en-US'));

  // 初始化路径
  const dataDir = path.join(ctx.baseDir, 'data');
  const caveDir = path.join(dataDir, 'cave');

  // 初始化存储系统
  await FileHandler.ensureDirectory(dataDir);
  await FileHandler.ensureDirectory(caveDir);
  await FileHandler.ensureDirectory(path.join(caveDir, 'resources'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'cave.json'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'pending.json'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'hash.json'));

  // 初始化核心组件
  const idManager = new IdManager(ctx.baseDir);
  const hashStorage = new HashStorage(caveDir);

  // 等待所有组件初始化完成
  await Promise.all([
    idManager.initialize(path.join(caveDir, 'cave.json'), path.join(caveDir, 'pending.json')),
    hashStorage.initialize()
  ]);

  const lastUsed = new Map<string, number>();

  // 处理列表查询
  async function processList(
    session: any,
    config: Config,
    userId?: string,
    pageNum: number = 1
  ): Promise<string> {
    const stats = idManager.getStats();

    // 如果指定了用户ID，只返回该用户的统计信息
    if (userId && userId in stats) {
      const ids = stats[userId];
      return session.text('commands.cave.list.totalItems', [userId, ids.length]) + '\n' +
             session.text('commands.cave.list.idsLine', [ids.join(',')]);
    }

    const lines: string[] = Object.entries(stats).map(([cid, ids]) => {
      return session.text('commands.cave.list.totalItems', [cid, ids.length]) + '\n' +
             session.text('commands.cave.list.idsLine', [ids.join(',')]);
    });

    const totalSubmissions = Object.values(stats).reduce((sum, arr) => sum + arr.length, 0);

    if (config.enablePagination) {
      const itemsPerPage = config.itemsPerPage;
      const totalPages = Math.max(1, Math.ceil(lines.length / itemsPerPage));
      pageNum = Math.min(Math.max(1, pageNum), totalPages);
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

  // 处理审核操作
  async function processAudit(
    pendingFilePath: string,
    caveFilePath: string,
    resourceDir: string,
    session: any,
    options: any,
    content: string[]
  ): Promise<string> {
    const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath)
    const isApprove = Boolean(options.p)
    if ((options.p === true && content[0] === 'all') ||
        (options.d === true && content[0] === 'all')) {
      return await handleAudit(pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session, idManager)
    }
    const id = parseInt(content[0] ||
      (typeof options.p === 'string' ? options.p : '') ||
      (typeof options.d === 'string' ? options.d : ''))
    if (isNaN(id)) {
      return sendMessage(session, 'commands.cave.error.invalidId', [], true)
    }
    return await handleAudit(pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session, idManager, id)
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
    session: any
  ): Promise<string | void> {
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    if (data.length === 0) {
      return sendMessage(session, 'commands.cave.error.noCave', [], true);
    }

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

    // 删除相关的媒体文件和哈希记录
    if (targetCave.elements) {
      const hashStorage = new HashStorage(caveDir);
      await hashStorage.initialize();

      // 使用新的清除方法
      await hashStorage.clearHashes(caveId);

      for (const element of targetCave.elements) {
        if ((element.type === 'img' || element.type === 'video') && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
          }
        }
      }
    }

    // 从数组中移除目标对象
    if (isPending) {
      const newPendingData = pendingData.filter(item => item.cave_id !== caveId);
      await FileHandler.writeJsonData(pendingFilePath, newPendingData);
    } else {
      const newData = data.filter(item => item.cave_id !== caveId);
      await FileHandler.writeJsonData(caveFilePath, newData);
      await idManager.removeStat(targetCave.contributor_number, caveId);
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
      const inputContent = content.length > 0 ? content.join('\n') : await (async () => {
        const reply = await session.prompt(session.text('commands.cave.add.noContent'));
        if (!reply) throw new Error(session.text('commands.cave.add.operationTimeout'));
        return reply;
      })();

      const caveId = await idManager.getNextId();

      if (inputContent.includes('/app/.config/QQ/')) {
        return sendMessage(session, 'commands.cave.add.localFileNotAllowed', [], true);
      }

      const bypassAudit = config.whitelist.includes(session.userId) ||
                         config.whitelist.includes(session.guildId) ||
                         config.whitelist.includes(session.channelId);

      const { imageUrls, imageElements, videoUrls, videoElements, textParts } =
        await extractMediaContent(inputContent, config, session);

      // 新增纯文本查重逻辑（仅在启用 MD5 查重时进行）
      const pureText = textParts
        .filter(tp => tp.type === 'text')
        .map((tp: any) => tp.content.trim())
        .join('\n').trim();

      if (config.enableMD5 && pureText) {
        const textHash = HashStorage.hashText(pureText);
        const textDuplicates = await hashStorage.findDuplicates('text', [textHash]);

        if (textDuplicates[0]) {
          const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
          const duplicateCave = data.find(item => item.cave_id === textDuplicates[0].caveId);

          if (duplicateCave) {
            await session.send(session.text('commands.cave.error.exactDuplicateFound') +
              await buildMessage(duplicateCave, resourceDir, session));
            await idManager.markDeleted(caveId);
            throw new Error('duplicate_found'); // 检测到重复时直接抛出错误来阻止添加
          }
        }
      }

      if (videoUrls.length > 0 && !config.allowVideo) {
        return sendMessage(session, 'commands.cave.add.videoDisabled', [], true);
      }

      // 保存媒体文件
      try {
        const [savedImages, savedVideos] = await Promise.all([
          imageUrls.length > 0 ? saveMedia(
            imageUrls,
            imageElements.map(el => el.fileName),
            resourceDir,
            caveId,
            'img',
            config,
            ctx,
            session
          ) : [],
          videoUrls.length > 0 ? saveMedia(
            videoUrls,
            videoElements.map(el => el.fileName),
            resourceDir,
            caveId,
            'video',
            config,
            ctx,
            session
          ) : []
        ]);

        const newCave: CaveObject = {
          cave_id: caveId,
          elements: [
            ...textParts,
            ...imageElements.map((el, idx) => ({
              ...el,
              file: savedImages[idx],
              // 保持原始文本和图片的相对位置
              index: el.index
            }))
          ].sort((a, b) => a.index - b.index),
          contributor_number: session.userId,
          contributor_name: session.username
        };

        // 如果有视频，直接添加到elements末尾，不需要计算index
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

        // 直接保存到 cave.json 时移除 index
        const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
        data.push({
          ...newCave,
          elements: cleanElementsForSave(newCave.elements, false)
        });

        // 先保存数据，再更新哈希，避免重复更新
        await FileHandler.writeJsonData(caveFilePath, data);

        // 更新哈希值，确保只更新一次
        if (config.enableMD5) {
          const updates = {
            caveId,
            texts: pureText ? [pureText] : [],
            images: savedImages?.length
              ? await Promise.all(savedImages.map(imagePath =>
                  fs.promises.readFile(path.join(resourceDir, imagePath))
                ))
              : []
          };

          if (updates.texts.length || updates.images.length) {
            await hashStorage.batchUpdateHashes(updates);
          }
        }

        await idManager.addStat(session.userId, caveId);

        // 在通过审核并成功保存后，更新纯文字 hash 记录（启用MD5时）
        if (config.enableMD5 && pureText) {
          const textHash = HashStorage.hashText(pureText);
          await hashStorage.updateHash(caveId, 'text', textHash);
        }

        return sendMessage(session, 'commands.cave.add.addSuccess', [caveId], false);

      } catch (error) {
        // 对于重复内容的错误，需要先清理cave ID再抛出错误
        if (error.message === 'duplicate_found') {
          await idManager.markDeleted(caveId);
        }
        throw error('${error.message}');
      }

    } catch (error) {
      logger.error(`Failed to process add command: ${error.message}`);
      return sendMessage(session, error.message, [], true);
    }
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
      // 审核命令权限检查
      if ((options.p || options.d) && !config.manager.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.managerOnly', [], true);
      }
    })
    .action(async ({ session, options }, ...content) => {
      const dataDir = path.join(ctx.baseDir, 'data');
      const caveDir = path.join(dataDir, 'cave');
      const caveFilePath = path.join(caveDir, 'cave.json');
      const resourceDir = path.join(caveDir, 'resources');
      const pendingFilePath = path.join(caveDir, 'pending.json');

      // 基础检查 - 需要冷却的命令
      const needsCooldown = !options.l && !options.a && !options.p && !options.d;
      if (needsCooldown) {
        const guildId = session.guildId;
        const now = Date.now();
        const lastTime = lastUsed.get(guildId) || 0;
        const isManager = config.manager.includes(session.userId);

        if (!isManager && now - lastTime < config.number * 1000) {
          const waitTime = Math.ceil((config.number * 1000 - (now - lastTime)) / 1000);
          return sendMessage(session, 'commands.cave.message.cooldown', [waitTime], true);
        }

        lastUsed.set(guildId, now);
      }

      // 处理各种命令
      if (options.l !== undefined) {
        const input = typeof options.l === 'string' ? options.l : content[0];
        const num = parseInt(input);

        if (config.manager.includes(session.userId)) {
          if (!isNaN(num)) {
            if (num < 10000) {
              return await processList(session, config, undefined, num);
            } else {
              return await processList(session, config, num.toString());
            }
          } else if (input) {
            return await processList(session, config, input);
          }
          return await processList(session, config);
        } else {
          return await processList(session, config, session.userId);
        }
      }

      if (options.p || options.d) {
        return await processAudit(pendingFilePath, caveFilePath, resourceDir, session, options, content);
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
      return await processRandom(caveFilePath, resourceDir, session);
    });
}

// 日志记录器
const logger = new Logger('cave');

// 核心类型定义
export interface Config {
  manager: string[]
  number: number
  enableAudit: boolean
  allowVideo: boolean
  videoMaxSize: number
  imageMaxSize: number
  blacklist: string[]
  whitelist: string[]
  enablePagination: boolean
  itemsPerPage: number
  duplicateThreshold: number
  enableDuplicate: boolean
  enableMD5: boolean
}

// 定义数据类型接口
interface BaseElement {
  type: 'text' | 'img' | 'video'
  index: number  // 元素排序索引
}

interface TextElement extends BaseElement {
  type: 'text'
  content: string // 文本内容
}

interface MediaElement extends BaseElement {
  type: 'img' | 'video'
  file?: string     // 保存的文件名
  fileName?: string // 原始文件名
  fileSize?: string // 文件大小
  filePath?: string // 文件路径
}

type Element = TextElement | MediaElement

export interface CaveObject {
  cave_id: number
  elements: Element[]
  contributor_number: string
  contributor_name: string
}

export interface PendingCave extends CaveObject {}

// 工具函数定义
// session: 会话上下文
// key: 消息key
// params: 消息参数
// isTemp: 是否为临时消息
// timeout: 临时消息超时时间
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

// 消息构建工具
// 清理元素数据用于保存
function cleanElementsForSave(elements: Element[], keepIndex: boolean = false): Element[] {
  if (!elements?.length) return [];

  const cleanedElements = elements.map(element => {
    if (element.type === 'text') {
      const cleanedElement: Partial<TextElement> = {
        type: 'text' as const,
        content: (element as TextElement).content
      };
      if (keepIndex) cleanedElement.index = element.index;
      return cleanedElement as TextElement;
    } else if (element.type === 'img' || element.type === 'video') {
      const mediaElement = element as MediaElement;
      const cleanedElement: Partial<MediaElement> = {
        type: mediaElement.type
      };
      if (mediaElement.file) cleanedElement.file = mediaElement.file;
      if (keepIndex) cleanedElement.index = element.index;
      return cleanedElement as MediaElement;
    }
    return element;
  });

  return keepIndex ? cleanedElements.sort((a, b) => (a.index || 0) - (b.index || 0)) : cleanedElements;
}
