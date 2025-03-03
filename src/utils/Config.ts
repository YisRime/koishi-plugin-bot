
import { Config as PluginConfig, SleepMode } from '../index'

/**
 * 配置验证器类，用于验证插件配置的有效性
 */
export class ConfigValidator {
  /**
   * 创建一个配置验证器实例
   * @param config 需要验证的配置对象
   */
  constructor(private config: PluginConfig) {}

  /**
   * 验证时间字符串是否符合 HH:MM 24小时制格式
   * @param time 需要验证的时间字符串
   * @returns 如果符合格式返回 true，否则返回 false
   */
  private validateTimeFormat(time: string): boolean {
    return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time);
  }

  /**
   * 验证睡眠时间配置是否有效
   * @throws {Error} 当睡眠时间格式无效时抛出错误
   */
  private validateSleepTime(): void {
    if (this.config.sleep.type === SleepMode.UNTIL &&
        !this.validateTimeFormat(this.config.sleep.until)) {
      throw new Error('Invalid sleep end time format');
    }
  }

  /**
   * 验证运势消息范围配置
   * 检查范围是否完整覆盖 0-100，且范围之间没有重叠或间隙
   * @throws {Error} 当范围格式无效、有重叠或间隙时抛出错误
   */
  private validateRangeMessages(): void {
    const rangeIntervals: [number, number][] = [];

    for (const rangeKey of Object.keys(this.config.rangeMessages)) {
      const [start, end] = rangeKey.split('-').map(Number);
      if (isNaN(start) || isNaN(end) || start > end || start < 0 || end > 100) {
        throw new Error(`Invalid range format: ${rangeKey}`);
      }
      rangeIntervals.push([start, end]);
    }

    rangeIntervals.sort((firstRange, secondRange) => firstRange[0] - secondRange[0]);

    if (rangeIntervals[0][0] !== 0 || rangeIntervals[rangeIntervals.length - 1][1] !== 100) {
      throw new Error('Ranges must completely cover 0 to 100');
    }

    for (let i = 1; i < rangeIntervals.length; i++) {
      if (rangeIntervals[i][0] !== rangeIntervals[i-1][1] + 1) {
        throw new Error(`Overlap or gap between ranges ${rangeIntervals[i-1][1]} and ${rangeIntervals[i][0]}`);
      }
    }
  }

  /**
   * 执行所有配置验证
   * @throws {Error} 当任何验证失败时抛出相应错误
   */
  validate(): void {
    this.validateSleepTime();
    this.validateRangeMessages();
  }
}
