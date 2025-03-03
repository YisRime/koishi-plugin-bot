// 基础依赖导入和插件元数据定义
import { Context, Schema, Random, h } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'
import { ZanwoMgr } from './utils/ZanwoMgr'
import { ConfigValidator } from './utils/Config'
import { JrrpMode } from './utils/JrrpMode'
import * as utils from './utils/utils'
import { CONSTANTS } from './utils/utils'

declare module 'koishi' {
  interface Tables {
    daily_user_data: DailyUserData
  }
}

// 定义表结构
export interface DailyUserData {
  id: number
  user_id: string
  zanwo_enabled: boolean
  identification_code?: string
  perfect_score: boolean
}

// 插件元数据定义
export const name = 'daily-tools'
export const inject = {required: ['database']}

/**
 * 睡眠模式类型枚举
 * @enum {string}
 */
export const enum SleepMode {
  STATIC = 'static',
  UNTIL = 'until',
  RANDOM = 'random'
}

/**
 * 禁言时长类型枚举
 * @enum {string}
 */
export const enum MuteDurationType {
  STATIC = 'static',
  RANDOM = 'random'
}

/**
 * JRRP算法类型枚举
 * @enum {string}
 */
export const enum JrrpAlgorithm {
  BASIC = 'basic',
  GAUSSIAN = 'gaussian',
  LINEAR = 'linear'
}

/**
 * 娱乐模式类型枚举
 * @enum {string}
 */
export const enum FoolMode {
  DISABLED = 'disabled',
  ENABLED = 'enabled'
}

/**
 * 显示模式类型枚举
 * @enum {string}
 */
export const enum DisplayMode {
  BINARY = 'binary',
  EXPRESSION = 'expression'
}

/**
 * 插件配置接口
 */
export interface SleepConfig {
  type: SleepMode
  duration?: number // static模式
  until?: string   // until模式
  min?: number     // random模式
  max?: number     // random模式
  allowedTimeRange?: string  // 允许使用时间段
}

export interface MuteConfig {
  type: MuteDurationType
  duration?: number // static模式
  min?: number     // random模式
  max?: number     // random模式
}

export interface FoolConfig {
  type: FoolMode
  date?: string
  displayMode?: DisplayMode
  baseNumber?: number
}

export interface Config {
  // autolike相关
  adminAccount?: string
  enableNotify?: boolean
  adminOnly?: boolean
  enableAutoBatch?: boolean

  // mute相关
  sleep: SleepConfig
  mute: MuteConfig
  allowedTimeRange?: string
  maxAllowedDuration: number
  enableMessage: boolean
  enableMuteOthers: boolean
  probability: number

  // jrrp相关
  choice: JrrpAlgorithm
  identificationCode: string
  fool: FoolConfig
  rangeMessages?: Record<string, string>
  specialMessages?: Record<number, string>
  holidayMessages?: Record<string, string>
}

// Schema配置定义
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    adminAccount: Schema.string(),
    enableNotify: Schema.boolean().default(true),
    adminOnly: Schema.boolean().default(true),
    enableAutoBatch: Schema.boolean().default(false),
  }).i18n({
    'zh-CN': require('./locales/zh-CN').config_autolike,
    'en-US': require('./locales/en-US').config_autolike,
  }),

  Schema.object({
    sleep: Schema.intersect([
      Schema.object({
        type: Schema.union([SleepMode.STATIC, SleepMode.UNTIL, SleepMode.RANDOM]),
      }).default({ type: SleepMode.STATIC }),
      Schema.union([
        Schema.object({
          type: Schema.const(SleepMode.STATIC).required(),
          duration: Schema.number().default(8),
        }),
        Schema.object({
          type: Schema.const(SleepMode.UNTIL).required(),
          until: Schema.string().default('08:00'),
        }),
        Schema.object({
          type: Schema.const(SleepMode.RANDOM).required(),
          min: Schema.number().default(6),
          max: Schema.number().default(10),
        }),
      ]),
    ]),
    mute: Schema.intersect([
      Schema.object({
        type: Schema.union([MuteDurationType.STATIC, MuteDurationType.RANDOM]),
      }).default({ type: MuteDurationType.STATIC }),
      Schema.union([
        Schema.object({
          type: Schema.const(MuteDurationType.STATIC).required(),
          duration: Schema.number().default(5),
        }),
        Schema.object({
          type: Schema.const(MuteDurationType.RANDOM).required(),
          min: Schema.number().default(0.1),
          max: Schema.number().default(10),
        }),
      ]),
    ]),
    allowedTimeRange: Schema.string().default('20-8').pattern(/^([01]?[0-9]|2[0-3])-([01]?[0-9]|2[0-3])$/),
    maxAllowedDuration: Schema.number().default(1440),
    enableMessage: Schema.boolean().default(false),
    enableMuteOthers: Schema.boolean().default(true),
    probability: Schema.number().default(0.5).min(0).max(1),
  }).i18n({
    'zh-CN': require('./locales/zh-CN').config_mute,
    'en-US': require('./locales/en-US').config_mute,
  }),

  Schema.object({
    choice: Schema.union([
      Schema.const(JrrpAlgorithm.BASIC),
      Schema.const(JrrpAlgorithm.GAUSSIAN),
      Schema.const(JrrpAlgorithm.LINEAR),
    ]).default(JrrpAlgorithm.BASIC),
    identificationCode: Schema.string().default('CODE').role('secret'),
    fool: Schema.intersect([
      Schema.object({
        type: Schema.union([FoolMode.DISABLED, FoolMode.ENABLED]),
      }).default({ type: FoolMode.DISABLED }),
      Schema.union([
        Schema.object({
          type: Schema.const(FoolMode.DISABLED),
        }),
        Schema.intersect([
          Schema.object({
            type: Schema.const(FoolMode.ENABLED).required(),
            date: Schema.string().default('4-1'),
          }),
          Schema.intersect([
            Schema.object({
              displayMode: Schema.union([DisplayMode.BINARY, DisplayMode.EXPRESSION]),
            }).default({ displayMode: DisplayMode.BINARY }),
            Schema.union([
              Schema.object({
                displayMode: Schema.const(DisplayMode.BINARY),
              }),
              Schema.object({
                displayMode: Schema.const(DisplayMode.EXPRESSION).required(),
                baseNumber: Schema.number().default(6).min(1).max(9),
              }),
            ]),
          ]),
        ]),
      ]),
    ]),
  }).i18n({
    'zh-CN': require('./locales/zh-CN').config_jrrp,
    'en-US': require('./locales/en-US').config_jrrp,
  }),
  Schema.object({
    rangeMessages: Schema.dict(String).default({
      '0-10': 'commands.jrrp.messages.range.1',
      '11-19': 'commands.jrrp.messages.range.2',
      '20-39': 'commands.jrrp.messages.range.3',
      '40-49': 'commands.jrrp.messages.range.4',
      '50-64': 'commands.jrrp.messages.range.5',
      '65-89': 'commands.jrrp.messages.range.6',
      '90-97': 'commands.jrrp.messages.range.7',
      '98-100': 'commands.jrrp.messages.range.8'
    }),
    specialMessages: Schema.dict(String).default({
      0: 'commands.jrrp.messages.special.1',
      50: 'commands.jrrp.messages.special.2',
      100: 'commands.jrrp.messages.special.3'
    }),
    holidayMessages: Schema.dict(String).default({
      '01-01': 'commands.jrrp.messages.date.1',
      '12-25': 'commands.jrrp.messages.date.2'
    })
  }).i18n({
    'zh-CN': require('./locales/zh-CN').config_range,
    'en-US': require('./locales/en-US').config_range,
  }),
])

/**
 * 插件主函数
 * @param {Context} ctx - Koishi 上下文
 * @param {Config} config - 插件配置
 */
export async function apply(ctx: Context, config: Config) {
  // 扩展数据库
  ctx.model.extend('daily_user_data', {
    id: 'unsigned',
    user_id: 'string',
    zanwo_enabled: 'boolean',
    identification_code: 'string',
    perfect_score: 'boolean',
  }, {
    primary: 'id',
    autoInc: true,
  })

  new ConfigValidator(config).validate();

  ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
  ctx.i18n.define('en-US', require('./locales/en-US'));

  const jrrpMode = new JrrpMode(ctx);
  utils.startCacheCleaner();
  const zanwoMgr = new ZanwoMgr(ctx);

  // 设置自动点赞任务
  if (config.enableAutoBatch) {
    ctx.setInterval(async () => {
      const targets = zanwoMgr.getList();
      if (targets.length) {
        const bots = Array.from(ctx.bots.values());
        for (const bot of bots) {
          const session = bot.session();
          if (session) {
            await zanwoMgr.sendBatchLikes(session, targets);
            break;
          }
        }
      }
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * 计算用户的运势分数
   * @description
   * 支持三种算法模式:
   * 1. basic - 基础哈希取模算法
   * 2. gaussian - 高斯分布算法,生成更符合正态分布的分数
   * 3. linear - 线性同余算法,生成均匀分布的分数
   *
   * 识别码模式下使用独立的计算逻辑
   */
  function calculateScore(userDateSeed: string, date: Date, identificationCode: string | undefined): number {
    let score: number;
    if (identificationCode) {
      score = jrrpMode.calculateJrrpWithCode(identificationCode, date, config.identificationCode);
    } else {
      switch (config.choice) {
        case JrrpAlgorithm.BASIC: {
          // 基础算法:对用户ID+日期的哈希值取模
          score = Math.abs(utils.hashCode(userDateSeed)) % 101;
          break;
        }
        case JrrpAlgorithm.GAUSSIAN: {
          // 高斯算法:使用Box-Muller变换生成正态分布随机数
          const normalRandom = (seed: string): number => {
            const hash = utils.hashCode(seed);
            const randomFactor = Math.sin(hash) * 10000;
            return randomFactor - Math.floor(randomFactor);
          };

          const toNormalLuck = (random: number): number => {
            const u1 = random;
            const u2 = normalRandom(random.toString());
            const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
            return Math.min(100, Math.max(0, Math.round(z * 15 + 50)));
          };

          const dateWeight = (date.getDay() + 1) / 7;
          const baseRandom = normalRandom(userDateSeed);
          const weightedRandom = (baseRandom + dateWeight) / 2;
          score = toNormalLuck(weightedRandom);
          break;
        }
        case JrrpAlgorithm.LINEAR: {
          // 线性同余算法:使用线性同余生成器
          const lcgSeed = utils.hashCode(userDateSeed);
          score = Math.floor(((lcgSeed * 9301 + 49297) % 233280) / 233280 * 101);
          break;
        }
        default: {
          score = Math.abs(utils.hashCode(userDateSeed)) % 101;
          break;
        }
      }
    }

    return score;
  }

  /**
   * 格式化JRRP结果消息
   * @param session - 会话上下文
   * @param dateForCalculation - 计算用的日期
   * @param config - 插件配置
   * @param jrrpMode - JRRP模式实例
   * @param skipConfirm - 是否跳过零分确认
   * @returns 格式化后的消息文本，如果需要零分确认则返回null
   */
  async function formatJrrpMessage(
    session: any,
    dateForCalculation: Date,
    config: Config,
    jrrpMode: JrrpMode,
    skipConfirm = false
  ): Promise<string | null> {
    const monthDay = `${String(dateForCalculation.getMonth() + 1).padStart(2, '0')}-${String(dateForCalculation.getDate()).padStart(2, '0')}`;
    const userDateSeed = `${session.userId}-${dateForCalculation.getFullYear()}-${monthDay}`;
    const identificationCode = jrrpMode.getIdentificationCode(session.userId);
    const userFortune = calculateScore(userDateSeed, dateForCalculation, identificationCode);

    // 零分确认检查 - 只有在不跳过确认且需要确认时才返回null
    if (!skipConfirm && identificationCode && userFortune === 0) {
      return null;
    }

    // 格式化分数显示
    const formattedFortune = jrrpMode.formatScore(userFortune, dateForCalculation, config.fool);
    let fortuneResultText = h('at', { id: session.userId }) + `${session.text('commands.jrrp.messages.result', [formattedFortune])}`;

    // 额外消息提示
    if (identificationCode && userFortune === 100 && jrrpMode.isPerfectScoreFirst(session.userId)) {
      await jrrpMode.markPerfectScore(session.userId);
      fortuneResultText += session.text(config.specialMessages[userFortune]) +
        '\n' + session.text('commands.jrrp.messages.identification_mode.perfect_score_first');
    } else if (config.specialMessages?.[userFortune]) {
      fortuneResultText += session.text(config.specialMessages[userFortune]);
    } else if (config.rangeMessages) {
      for (const [range, message] of Object.entries(config.rangeMessages)) {
        const [min, max] = range.split('-').map(Number);
        if (userFortune >= min && userFortune <= max) {
          fortuneResultText += session.text(message);
          break;
        }
      }
    }

    // 添加节日消息
    if (config.holidayMessages?.[monthDay]) {
      fortuneResultText += '\n' + session.text(config.holidayMessages[monthDay]);
    }

    return fortuneResultText;
  }

  /**
   * 精致睡眠命令处理
   * @description
   * 三种睡眠模式:
   * 1. static - 固定时长,使用配置的duration
   * 2. until - 指定时间,计算到指定时间的时长
   * 3. random - 随机时长,在min和max之间随机
   *
   */
  ctx.command('sleep')
    .alias('jzsm', '精致睡眠')
    .channelFields(['guildId'])
    .action(async ({ session }) => {
      try {
        // 检查当前时间是否在允许的时间段内
        const now = new Date();
        const currentHour = now.getHours();
        const [startHour, endHour] = config.allowedTimeRange.split('-').map(Number);

        const isTimeAllowed = startHour > endHour
          ? (currentHour >= startHour || currentHour <= endHour)  // 跨夜情况，如20-8
          : (currentHour >= startHour && currentHour <= endHour); // 普通情况，如9-18

        if (!isTimeAllowed) {
          const message = await session.send(session.text('commands.sleep.errors.not_allowed_time', [config.allowedTimeRange]));
          await utils.autoRecall(session, message);
          return;
        }

        let duration: number;
        const sleep = config.sleep;

        switch (sleep.type) {
          case SleepMode.STATIC:
            duration = Math.max(1, sleep.duration) * 60;
            break;
          case SleepMode.UNTIL:
            const [hours, minutes] = sleep.until.split(':').map(Number);
            if (isNaN(hours) || isNaN(minutes)) {
              throw new Error(session.text('commands.sleep.errors.invalid_time'));
            }
            const endTime = new Date(now);
            endTime.setHours(hours, minutes, 0, 0);
            if (endTime <= now) endTime.setDate(endTime.getDate() + 1);
            duration = Math.max(1, Math.floor((endTime.getTime() - now.getTime()) / 60000));
            break;
          case SleepMode.RANDOM:
            const min = Math.max(1, sleep.min) * 60;
            const max = Math.max(sleep.max, sleep.min) * 60;
            duration = Math.floor(Math.random() * (max - min + 1) + min);
            break;
        }

        await session.bot.muteGuildMember(session.guildId, session.userId, duration * 60 * 1000);
        return session.text('commands.sleep.messages.success');
      } catch (error) {
        const message = await session.send(session.text('commands.sleep.messages.failed'));
        await utils.autoRecall(session, message);
        return;
      }
    });

  /**
   * 点赞命令处理
   * @description
   * 改为子命令结构:
   * 1. zanwo - 默认点赞自己
   * 2. zanwo.list - 查看点赞目标列表
   * 3. zanwo.add - 添加点赞目标
   * 4. zanwo.remove - 移除点赞目标
   * 5. zanwo.user - 指定目标点赞
   */
  const zanwo = ctx.command('zanwo')
    .alias('赞我')
    .action(async ({ session }) => {
      const success = await zanwoMgr.sendLikes(session, session.userId);
      const message = await session.send(
        success
          ? session.text('commands.zanwo.messages.success', [config.enableNotify ? (config.adminAccount || '') : ''])
          : session.text('commands.zanwo.messages.like_failed')
      );
      await utils.autoRecall(session, message);
    });

  // 列表查看功能
  zanwo.subcommand('.list')
    .action(async ({ session }) => {
      if (config.adminOnly && session.userId !== config.adminAccount) {
        return session.text('commands.zanwo.messages.permission_denied');
      }

      const targets = zanwoMgr.getList();
      return targets.length
        ? session.text('commands.zanwo.messages.list', [targets.join(', ')])
        : session.text('commands.zanwo.messages.no_targets');
    });

  // 添加目标功能
  zanwo.subcommand('.add <target:text>')
    .action(async ({ session }, target) => {
      if (config.adminOnly && session.userId !== config.adminAccount) {
        return session.text('commands.zanwo.messages.permission_denied');
      }

      const parsedTarget = utils.parseTarget(target);
      if (!parsedTarget) {
        return session.text('commands.zanwo.messages.target_not_found');
      }

      const success = await zanwoMgr.addQQ(parsedTarget);
      return session.text(`commands.zanwo.messages.add_${success ? 'success' : 'failed'}`, [parsedTarget]);
    });

  // 移除目标功能
  zanwo.subcommand('.remove <target:text>')
    .action(async ({ session }, target) => {
      if (config.adminOnly && session.userId !== config.adminAccount) {
        return session.text('commands.zanwo.messages.permission_denied');
      }

      const parsedTarget = utils.parseTarget(target);
      if (!parsedTarget) {
        return session.text('commands.zanwo.messages.target_not_found');
      }

      const success = await zanwoMgr.removeQQ(parsedTarget);
      return session.text(`commands.zanwo.messages.remove_${success ? 'success' : 'failed'}`, [parsedTarget]);
    });

  // 指定用户点赞功能
  zanwo.subcommand('.user <target:text>')
    .action(async ({ session }, target) => {
      const parsedTarget = utils.parseTarget(target);
      if (!parsedTarget || parsedTarget === session.userId) {
        const message = await session.send(session.text('commands.zanwo.messages.target_not_found'));
        await utils.autoRecall(session, message);
        return;
      }

      const success = await zanwoMgr.sendLikes(session, parsedTarget);
      const message = await session.send(
        success
          ? session.text('commands.zanwo.messages.success', [config.enableNotify ? (config.adminAccount || '') : ''])
          : session.text('commands.zanwo.messages.like_failed')
      );
      await utils.autoRecall(session, message);
    });

  /**
   * 禁言命令处理
   * @description
   * 支持以下功能:
   * 1. mute - 随机选择目标禁言
   * 2. mute.me - 禁言自己
   * 3. mute.user - 指定目标禁言
   */
  const muteCmd = ctx.command('mute [duration:number]')
    .channelFields(['guildId'])
    .action(async ({ session }, duration) => {
      if (duration && duration > config.maxAllowedDuration) {
        const message = await session.send(session.text('commands.mute.messages.errors.duration_too_long', [config.maxAllowedDuration]));
        await utils.autoRecall(session, message);
        return;
      }

      // 如果不允许禁言他人，默认禁言自己
      if (!config.enableMuteOthers) {
        const message = await session.send(session.text('commands.mute.messages.notify.others_disabled'));
        await utils.autoRecall(session, message);
        return;
      }

      const muteDuration = utils.calculateMuteDuration(config.mute.type, config.mute.duration, config.mute.min, config.mute.max, duration);

      try {
        const validMembers = await utils.getCachedMemberList(session);
        if (!validMembers.length) {
          const message = await session.send(session.text('commands.mute.messages.errors.no_valid_members'));
          await utils.autoRecall(session, message);
          return;
        }

        if (!new Random().bool(config.probability)) {
          await utils.executeMute(session, session.userId, muteDuration, config.enableMessage);
          return;
        }

        // 随机选择目标并执行禁言
        const targetIndex = new Random().int(0, validMembers.length - 1);
        const targetId = validMembers[targetIndex];
        await utils.executeMute(session, targetId, muteDuration, config.enableMessage);
      } catch (error) {
        console.error('Failed to execute random mute:', error);
        const message = await session.send(session.text('commands.mute.messages.errors.no_valid_members'));
        await utils.autoRecall(session, message);
      }
    });

  // 禁言自己子命令
  muteCmd.subcommand('.me [duration:number]')
    .action(async ({ session }, duration) => {
      if (duration && duration > config.maxAllowedDuration) {
        const message = await session.send(session.text('commands.mute.messages.errors.duration_too_long', [config.maxAllowedDuration]));
        await utils.autoRecall(session, message);
        return;
      }

      const muteDuration = utils.calculateMuteDuration(config.mute.type, config.mute.duration, config.mute.min, config.mute.max,duration);
      await utils.executeMute(session, session.userId, muteDuration, config.enableMessage);
    });

  // 指定目标禁言子命令
  muteCmd.subcommand('.user <target:text> [duration:number]')
    .action(async ({ session }, target, duration) => {
      if (!config.enableMuteOthers) {
        const message = await session.send(session.text('commands.mute.messages.notify.others_disabled'));
        await utils.autoRecall(session, message);
        return;
      }

      if (duration && duration > config.maxAllowedDuration) {
        const message = await session.send(session.text('commands.mute.messages.errors.duration_too_long', [config.maxAllowedDuration]));
        await utils.autoRecall(session, message);
        return;
      }

      const muteTargetId = utils.parseTarget(target);
      if (!muteTargetId || muteTargetId === session.userId) {
        await utils.executeMute(session, session.userId, duration * 60 || config.mute.duration * 60, config.enableMessage);
        return;
      }

      const muteDuration = utils.calculateMuteDuration(config.mute.type, config.mute.duration, config.mute.min, config.mute.max,duration);

      if (!new Random().bool(config.probability)) {
        await utils.executeMute(session, session.userId, muteDuration, config.enableMessage);
        return;
      }

      await utils.executeMute(session, muteTargetId, muteDuration, config.enableMessage);
    });

  const jrrpCmd = ctx.command('jrrp')
    .action(async ({ session }) => {
      try {
        const dateForCalculation = new Date();
        const monthDay = `${String(dateForCalculation.getMonth() + 1).padStart(2, '0')}-${String(dateForCalculation.getDate()).padStart(2, '0')}`;

        if (config.holidayMessages?.[monthDay]) {
          const holidayMessage = session.text(config.holidayMessages[monthDay]);
          const promptMessage = await session.send(holidayMessage + '\n' + session.text('commands.jrrp.messages.prompt'));
          await utils.autoRecall(session, promptMessage);
          const response = await session.prompt(CONSTANTS.TIMEOUTS.PROMPT);
          if (!response) {
            await session.send(session.text('commands.jrrp.messages.cancel'));
            return;
          }
        }

        let fortuneResultText = await formatJrrpMessage(session, dateForCalculation, config, jrrpMode);

        // 处理零分确认
        if (fortuneResultText === null) {
          await session.send(session.text('commands.jrrp.messages.identification_mode.zero_prompt'));
          const response = await session.prompt(CONSTANTS.TIMEOUTS.PROMPT);
          if (!response || response.toLowerCase() !== 'y') {
            const message = await session.send(session.text('commands.jrrp.messages.cancel'));
            await utils.autoRecall(session, message);
            return;
          }
          fortuneResultText = await formatJrrpMessage(session, dateForCalculation, config, jrrpMode, true);
        }

        if (fortuneResultText) {
          await session.send(fortuneResultText);
        }
      } catch (error) {
        console.error('Daily fortune calculation failed:', error);
        const message = await session.send(session.text('commands.jrrp.messages.error'));
        await utils.autoRecall(session, message);
      }
    })

  // 日期查询子命令
  jrrpCmd.subcommand('.date <date:text>')
    .usage('输入日期格式：YYYY-MM-DD 或 MM-DD')
    .action(async ({ session }, date) => {
      if (!date?.trim()) {
        const message = await session.send(session.text('commands.jrrp.errors.invalid_date'));
        await utils.autoRecall(session, message);
        return;
      }

      const dateForCalculation = utils.parseDate(date, new Date());
      if (!dateForCalculation) {
        const message = await session.send(session.text('commands.jrrp.errors.invalid_date'));
        await utils.autoRecall(session, message);
        return;
      }

      try {
        let fortuneResultText = await formatJrrpMessage(session, dateForCalculation, config, jrrpMode);

        // 处理零分确认
        if (fortuneResultText === null) {
          await session.send(session.text('commands.jrrp.messages.identification_mode.zero_prompt'));
          const response = await session.prompt(CONSTANTS.TIMEOUTS.PROMPT);
          if (!response || response.toLowerCase() !== 'y') {
            const message = await session.send(session.text('commands.jrrp.messages.cancel'));
            await utils.autoRecall(session, message);
            return;
          }
          fortuneResultText = await formatJrrpMessage(session, dateForCalculation, config, jrrpMode, true);
        }

        if (fortuneResultText) {
          await session.send(fortuneResultText);
        }
      } catch (error) {
        const message = await session.send(session.text('commands.jrrp.messages.error'));
        await utils.autoRecall(session, message);
      }
    });

  // 绑定识别码子命令
  jrrpCmd.subcommand('.bind [code:string]')
    .action(async ({ session }, code) => {
      try {
        let responseText: string;
        if (session.messageId) {
          await utils.autoRecall(session, session.messageId, 500);
        }

        if (!code) {
          await jrrpMode.removeIdentificationCode(session.userId);
          responseText = session.text('commands.jrrp.messages.identification_mode.unbind_success');
        } else {
          const formattedCode = code.trim().toUpperCase();

          if (!formattedCode || !jrrpMode.validateIdentificationCode(formattedCode)) {
            responseText = session.text('commands.jrrp.messages.identification_mode.invalid_code');
          } else {
            const existingCode = await jrrpMode.getIdentificationCode(session.userId);

            if (existingCode === formattedCode) {
              responseText = session.text('commands.jrrp.messages.identification_mode.already_bound');
            } else {
              await jrrpMode.bindIdentificationCode(session.userId, formattedCode);
              responseText = session.text(
                existingCode
                  ? 'commands.jrrp.messages.identification_mode.rebind_success'
                  : 'commands.jrrp.messages.identification_mode.bind_success'
              );
            }
          }
        }

        const message = await session.send(responseText);
        await utils.autoRecall(session, message);
      } catch (error) {
        console.error('Failed to handle identification code:', error);
        const message = await session.send(session.text('commands.jrrp.messages.error'));
        await utils.autoRecall(session, message);
      }
    })

  // 查找特定分数日期子命令
  jrrpCmd.subcommand('.score <score:number>')
    .action(async ({ session }, score) => {
      if (score < 0 || score > 100) {
        const message = await session.send(session.text('commands.jrrp.messages.invalid_number'));
        await utils.autoRecall(session, message);
        return;
      }

      const identificationCode = jrrpMode.getIdentificationCode(session.userId);
      const currentDate = new Date();

      for (let daysAhead = 1; daysAhead <= CONSTANTS.LIMITS.MAX_DAYS_TO_CHECK; daysAhead++) {
        const futureDate = new Date(currentDate);
        futureDate.setDate(currentDate.getDate() + daysAhead);

        const dateStr = `${futureDate.getFullYear()}-${String(futureDate.getMonth() + 1).padStart(2, '0')}-${String(futureDate.getDate()).padStart(2, '0')}`;
        const userDateSeed = `${session.userId}-${dateStr}`;
        const calculatedScore = calculateScore(userDateSeed, futureDate, identificationCode);

        if (calculatedScore === score) {
          const formattedDate = `${futureDate.getFullYear().toString().slice(-2)}-${String(futureDate.getMonth() + 1).padStart(2, '0')}-${String(futureDate.getDate()).padStart(2, '0')}`;
          await session.send(session.text('commands.jrrp.messages.found_date', [score, formattedDate]));
          return;
        }
      }

      await session.send(session.text('commands.jrrp.messages.not_found', [score]));
    })
}
