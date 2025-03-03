/**
 * @fileoverview 工具函数模块，提供通用工具函数和缓存管理功能
 * @module utils
 */

import { Session, h, Random } from 'koishi';
import { MuteDurationType } from '../index';

/**
 * 常量配置对象，包含各种系统配置值
 * @namespace
 * @property {Object} CACHE_KEYS - 缓存键生成函数集合
 * @property {Object} TIMEOUTS - 超时时间配置
 * @property {Object} LIMITS - 系统限制配置
 */
export const CONSTANTS = {
  CACHE_KEYS: {
    MEMBER_LIST: (platform: string, guildId: string) => `members:${platform}:${guildId}`,
  },
  TIMEOUTS: {
    PROMPT: 10000,
    AUTO_RECALL: 10000,
    LIKE_DELAY: 500,
  },
  LIMITS: {
    MAX_DAYS_TO_CHECK: 365,
    MAX_CACHE_SIZE: 1000,
  }
};

/**
 * 缓存配置对象，定义各类缓存的过期时间
 * @namespace
 * @property {number} memberListExpiry - 成员列表缓存过期时间（毫秒）
 */
export const cacheConfig = {
  memberListExpiry: 3600000, // 1小时
};

/**
 * 统一的缓存结构
 * @interface CacheEntry
 * @template T
 * @property {T} data - 缓存的数据
 * @property {number} expiry - 缓存的过期时间
 */
interface CacheEntry<T> {
  data: T;
  expiry: number;
}

/**
 * 统一的缓存存储
 * @namespace
 * @property {Map<string, CacheEntry<string[]>>} memberList - 群成员列表缓存
 */
export const cacheStore = {
  memberList: new Map<string, CacheEntry<string[]>>(),
};

/**
 * 自动撤回消息
 * @param {Session} session - 会话上下文，用于执行消息操作
 * @param {string|string[]|object|object[]} message - 要撤回的消息或消息ID数组。可以是消息ID字符串、消息对象或它们的数组
 * @param {number} [delay] - 延迟撤回时间（毫秒），默认使用 CONSTANTS.TIMEOUTS.AUTO_RECALL
 * @returns {Promise<Function>} 返回一个取消撤回的函数，调用该函数可以阻止消息被撤回
 * @throws {Error} 当消息删除操作失败时可能抛出错误
 */
export async function autoRecall(session, message, delay = CONSTANTS.TIMEOUTS.AUTO_RECALL) {
  if (!message) return;

  const timer = setTimeout(async () => {
    try {
      const messages = Array.isArray(message) ? message : [message];
      await Promise.all(messages.map(async msg => {
        const msgId = typeof msg === 'string' ? msg : msg?.id;
        if (msgId) {
          await session.bot.deleteMessage(session.channelId, msgId);
        }
      }));
    } catch (error) {
      console.warn('Failed to execute auto recall:', error);
    }
  }, delay);

  return () => clearTimeout(timer);
}

/**
 * 获取缓存的群成员列表
 * @param {Session} session - 会话上下文，包含群组和平台信息
 * @returns {Promise<string[]>} 返回群成员ID列表，如果获取失败则返回空数组
 * @throws {Error} 当群成员列表获取失败时可能抛出错误
 * @description 该函数会优先从缓存中获取群成员列表，如果缓存不存在或已过期，则重新获取并更新缓存
 */
export async function getCachedMemberList(session): Promise<string[]> {
  const key = CONSTANTS.CACHE_KEYS.MEMBER_LIST(session.platform, session.guildId);
  const cached = getCached(key, cacheStore.memberList);
  if (cached) return cached;

  try {
    const memberList = await session.onebot.getGroupMemberList(session.guildId);
    const filteredMembers = memberList
      .filter(member =>
        member.role === 'member' &&
        String(member.user_id) !== String(session.selfId))
      .map(member => String(member.user_id));

    setCached(key, filteredMembers, cacheStore.memberList, cacheConfig.memberListExpiry);
    return filteredMembers;
  } catch (error) {
    console.error('Failed to get member list:', error);
    return [];
  }
}

/**
 * 启动缓存清理器
 * @param {number} [interval=21600000] - 清理间隔时间（毫秒），默认6小时
 * @returns {NodeJS.Timeout} 返回定时器句柄
 * @description 定期清理所有过期的缓存数据，包括群成员列表和JRRP分数缓存
 */
export function startCacheCleaner(interval = 21600000) {
  setInterval(() => {
    const now = Date.now();
    for (const map of Object.values(cacheStore)) {
      for (const [key, entry] of map.entries()) {
        if (entry.expiry <= now) map.delete(key);
      }
    }
  }, interval);
}

/**
 * 计算字符串的哈希值
 * @param {string} inputStr - 要计算哈希值的输入字符串
 * @returns {number} 返回计算得到的32位无符号整数哈希值
 * @description 使用 DJB2 哈希算法计算字符串的哈希值
 */
export function hashCode(inputStr: string): number { // 改进：str -> inputStr
  let hashValue = 5381; // 改进：hash -> hashValue
  for (let charIndex = 0; inputStr.length > charIndex; charIndex++) { // 改进：i -> charIndex
    hashValue = ((hashValue << 5) + hashValue) + inputStr.charCodeAt(charIndex);
    hashValue = hashValue >>> 0;
  }
  return hashValue;
}

/**
 * 解析并验证日期字符串
 * @param {string} dateStr - 日期字符串，支持 YYYY-MM-DD、YY-MM-DD、MM-DD 等格式
 * @param {Date} defaultDate - 默认日期对象，用于补充省略的年份信息
 * @returns {Date|null} 解析成功返回日期对象，失败返回 null
 * @description 支持多种日期格式，自动处理两位年份，并进行严格的日期有效性验证
 */
export function parseDate(dateStr: string, defaultDate: Date): Date | null {
  if (!dateStr?.trim()) return null;

  // 标准化日期字符串，支持点号和斜杠分隔
  const normalized = dateStr.trim().replace(/[\s.\/]/g, '-').replace(/-+/g, '-');
  if (!/^[\d-]+$/.test(normalized)) return null;

  // 处理可能的前导零
  const parts = normalized.split('-').map(part => parseInt(part.replace(/^0+/, ''), 10));
  if (!parts.every(n => n > 0)) return null;

  let year: number, month: number, day: number;

  switch (parts.length) {
    case 3: // YYYY-MM-DD 或 YY-MM-DD
      [year, month, day] = parts;
      if (year < 100) {
        const currentYear = defaultDate.getFullYear();
        const threshold = (currentYear % 100 + 20) % 100;
        year = year > threshold ? 1900 + year : 2000 + year;
      }
      break;
    case 2: // MM-DD
      [month, day] = parts;
      year = defaultDate.getFullYear();
      break;
    default:
      return null;
  }

  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  ) ? date : null;
}

/**
 * 执行禁言操作
 * @param {Session} session - 会话上下文，包含群组和用户信息
 * @param {string} targetId - 目标用户ID
 * @param {number} muteDuration - 禁言时长（秒）
 * @param {boolean} enableMessage - 是否发送禁言提示消息
 * @returns {Promise<boolean>} 操作成功返回 true，失败返回 false
 * @description 执行禁言操作并处理相关消息，支持自动清理命令消息和发送提示
 */
export async function executeMute(session: Session, targetId: string, muteDuration: number, enableMessage: boolean): Promise<boolean> {
  try {
    await session.onebot.setGroupBan(session.guildId, targetId, muteDuration);

    if (session.messageId) {
      try {
        await session.bot.deleteMessage(session.channelId, session.messageId);
      } catch {}
    }

    if (enableMessage) {
      const [minutes, seconds] = [(muteDuration / 60) | 0, muteDuration % 60];
      const isTargetSelf = targetId === session.userId;
      const messageKey = isTargetSelf
        ? 'commands.mute.messages.notify.self_muted'
        : 'commands.mute.messages.notify.target_muted';

      const username = isTargetSelf
        ? session.username
        : ((await session.app.database.getUser(session.platform, targetId))?.name || targetId);

      const message = await session.send(session.text(messageKey, [username, minutes, seconds]));
      await autoRecall(session, message);
    }
    return true;
  } catch (error) {
    console.error('Mute operation failed:', error);
    return false;
  }
}

/**
 * 解析目标用户ID
 * @param {string} input - 输入文本，可以是@消息或直接的用户ID
 * @returns {string|null} 解析出的用户ID，解析失败则返回null
 */
export function parseTarget(input: string): string | null {
  if (!input?.trim()) return null;
  const parsedUser = h.parse(input)[0];
  return parsedUser?.type === 'at' ? parsedUser.attrs.id : input.trim();
}

/**
 * 统一的缓存管理函数
 * @template T 缓存数据的类型
 * @param {string} key - 缓存键
 * @param {Map<string, CacheEntry<T>>} map - 缓存存储映射
 * @returns {T|null} 返回缓存的数据，如果不存在或已过期则返回 null
 * @description 获取缓存数据，自动处理过期清理
 */
function getCached<T>(key: string, map: Map<string, CacheEntry<T>>): T | null {
  const entry = map.get(key);
  if (entry && entry.expiry > Date.now()) {
    return entry.data;
  }
  map.delete(key); // 自动清理过期数据
  return null;
}

/**
 * 设置缓存数据
 * @template T 缓存数据的类型
 * @param {string} key - 缓存键
 * @param {T} data - 要缓存的数据
 * @param {Map<string, CacheEntry<T>>} map - 缓存存储映射
 * @param {number} [expiry] - 缓存过期时间（毫秒），默认使用 cacheConfig.jrrpExpiry
 * @description 将数据存入缓存，并设置过期时间
 */
function setCached<T>(key: string, data: T, map: Map<string, CacheEntry<T>>, expiry = cacheConfig.memberListExpiry): void {
  map.set(key, {
    data,
    expiry: Date.now() + expiry
  });
}

/**
 * 计算禁言时长
 * @param {MuteDurationType} type - 禁言类型
 * @param {number} duration - 固定时长
 * @param {number} min - 最小时长
 * @param {number} max - 最大时长
 * @param {number} [specifiedDuration] - 指定的时长
 * @returns {number} 最终计算的禁言时长（秒）
 */
export function calculateMuteDuration(
  type: MuteDurationType,
  duration: number,
  min: number,
  max: number,
  specifiedDuration?: number
): number {
  if (specifiedDuration) {
    return specifiedDuration * 60;
  }
  switch (type) {
    case MuteDurationType.STATIC:
      return duration * 60;
    case MuteDurationType.RANDOM:
      return new Random().int(min * 60, max * 60);
    default:
      return 5 * 60;
  }
}
