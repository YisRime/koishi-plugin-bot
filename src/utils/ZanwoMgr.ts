
import { Context } from 'koishi'
import { CONSTANTS } from './utils'

/**
 * 赞我管理器
 * 用于管理自动点赞功能的账号列表，包括数据的持久化存储和点赞操作
 */
export class ZanwoMgr {
  /** 存储需要自动点赞的ID集合 */
  private likeTargets: Set<string> = new Set();

  /**
   * 创建一个新的赞我管理器实例
   * @param ctx Koishi上下文对象
   */
  constructor(private ctx: Context) {
    this.loadData();
  }

  /**
   * 从数据库加载点赞列表数据
   */
  private async loadData(): Promise<void> {
    try {
      const records = await this.ctx.database.get('daily_user_data', {
        zanwo_enabled: true
      })
      this.likeTargets = new Set(records.map(record => record.user_id))
    } catch (error) {
      this.ctx.logger.error('Failed to load zanwo data:', error)
    }
  }

  /**
   * 添加一个ID到点赞列表
   * @param target - 要添加的ID
   * @returns 添加是否成功
   */
  async addQQ(target: string): Promise<boolean> {
    if (!/^\d+$/.test(target)) return false
    try {
      await this.ctx.database.upsert('daily_user_data', [{
        user_id: target,
        zanwo_enabled: true,
        perfect_score: false
      }], ['user_id'])

      this.likeTargets.add(target)
      return true
    } catch {
      return false
    }
  }

  /**
   * 从点赞列表中移除一个ID
   * @param target - 要移除的ID
   * @returns 移除是否成功
   */
  async removeQQ(target: string): Promise<boolean> {
    if (!this.likeTargets.has(target)) return false
    try {
      await this.ctx.database.set('daily_user_data', {
        user_id: target
      }, {
        zanwo_enabled: false
      })
      this.likeTargets.delete(target)
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取当前赞我列表中的所有ID
   * @returns ID字符串数组
   */
  getList(): string[] {
    return [...this.likeTargets];
  }

  /**
   * 向指定用户发送点赞
   * @param session - 会话上下文
   * @param targetId - 目标用户ID
   * @param count - 点赞次数，默认5次
   * @param concurrency - 并发数，默认3
   * @returns 点赞是否成功完成
   */
  async sendLikes(session, targetId: string, count: number = 5, concurrency: number = 3): Promise<boolean> {
    const chunks: number[][] = [];
    for (let i = 0; i < count; i += concurrency) {
      chunks.push(Array(Math.min(concurrency, count - i)).fill(1));
    }

    try {
      for (const chunk of chunks) {
        const promises = chunk.map(() =>
          session.bot.internal.sendLike(targetId, 10).catch(() => null)
        );

        await Promise.all([
          ...promises,
          new Promise(resolve => setTimeout(resolve, CONSTANTS.TIMEOUTS.LIKE_DELAY))
        ]);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 批量发送点赞
   * @param session - 会话上下文
   * @param targetIds - 目标用户ID数组
   * @param count - 每个用户的点赞次数
   * @param concurrency - 单用户并发数
   * @returns 点赞结果映射
   */
  async sendBatchLikes(
    session,
    targetIds: string[],
    count: number = 5,
    concurrency: number = 3
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    for (const targetId of targetIds) {
      results.set(targetId, await this.sendLikes(session, targetId, count, concurrency));
      // 每个用户之间添加短暂延迟，避免请求过于密集
      await new Promise(resolve => setTimeout(resolve, CONSTANTS.TIMEOUTS.LIKE_DELAY));
    }

    return results;
  }
}
