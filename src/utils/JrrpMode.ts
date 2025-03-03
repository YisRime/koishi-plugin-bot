
import { Context } from 'koishi'
import { DisplayMode, FoolConfig, FoolMode } from '..';

/**
 * JRRP处理类
 * 用于处理用户识别码绑定和今日人品计算规则
 */
export class JrrpMode {
  /** 存储用户ID和识别码的映射关系 */
  private identificationCodes = new Map<string, string>();

  /** 记录用户是否已获得过满分的状态 */
  private perfectScoreRecords = new Map<string, boolean>();

  /** 存储数字到表达式的映射，用于生成数学表达式 */
  private digitExpressions = new Map<number, string>();

  /** 标记是否已经初始化过表达式映射 */
  private expressionsInitialized = false;

  /**
   * 创建JRRP特殊模式处理实例
   * @param ctx - Koishi应用上下文，用于日志记录和其他功能
   */
  constructor(private ctx: Context) {
    this.loadData();
  }

  /**
   * 计算指定日期在一年中的天数(1-366)
   * @param date 日期对象
   * @returns 一年中的第几天
   */
  private getDayOfYear(date: Date): number {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date.getTime() - start.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
  }

  /**
   * 计算字符串的64位哈希值
   * @param str 输入字符串
   * @returns 64位哈希值
   */
  private getHash(str: string): bigint {
    let hash = BigInt(5381);
    for (let i = 0; str.length > i; i++) {
      hash = ((hash << BigInt(5)) ^ hash ^ BigInt(str.charCodeAt(i))) & ((BigInt(1) << BigInt(64)) - BigInt(1));
    }
    return hash ^ BigInt('0xa98f501bc684032f');
  }

  /**
   * 从数据库加载JRRP数据
   */
  private async loadData(): Promise<void> {
    try {
      const records = await this.ctx.database.get('daily_user_data', {})
      for (const record of records) {
        if (record.identification_code) {
          this.identificationCodes.set(record.user_id, record.identification_code)
        }
        this.perfectScoreRecords.set(record.user_id, record.perfect_score)
      }
    } catch (error) {
      this.ctx.logger.error('Failed to load JRRP data:', error)
    }
  }

  /**
   * 标记用户已获得满分
   * @param userId 用户ID
   */
  async markPerfectScore(userId: string): Promise<void> {
    try {
      await this.ctx.database.upsert('daily_user_data', [{
        user_id: userId,
        perfect_score: true
      }], ['user_id'])

      this.perfectScoreRecords.set(userId, true)
    } catch (error) {
      this.ctx.logger.error('Failed to mark perfect score:', error)
    }
  }

  /**
   * 检查用户是否首次获得满分
   * @param userId 用户ID
   * @returns 是否是首次获得满分
   */
  isPerfectScoreFirst(userId: string): boolean {
    return !this.perfectScoreRecords.get(userId);
  }

  /**
   * 验证识别码格式是否正确
   * @param code 识别码
   * @returns 是否符合XXXX-XXXX-XXXX-XXXX格式(X为16进制数字)
   */
  validateIdentificationCode(code: string): boolean {
    // 修改验证逻辑，使其更严格
    return /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/i.test(code.trim());
  }

  /**
   * 绑定用户的识别码
   * @param userId 用户ID
   * @param code 识别码
   */
  async bindIdentificationCode(userId: string, code: string): Promise<void> {
    try {
      await this.ctx.database.upsert('daily_user_data', [{
        user_id: userId,
        identification_code: code.trim().toUpperCase()
      }], ['user_id'])

      this.identificationCodes.set(userId, code.trim().toUpperCase())
    } catch (error) {
      this.ctx.logger.error('Failed to bind identification code:', error)
    }
  }

  /**
   * 移除用户的识别码
   * @param userId 用户ID
   */
  async removeIdentificationCode(userId: string): Promise<void> {
    try {
      await this.ctx.database.set('daily_user_data', {
        user_id: userId
      }, {
        identification_code: null
      })
      this.identificationCodes.delete(userId)
    } catch (error) {
      this.ctx.logger.error('Failed to remove identification code:', error)
    }
  }

  /**
   * 获取用户的识别码
   * @param userId 用户ID
   * @returns 用户绑定的识别码，未绑定则返回undefined
   */
  getIdentificationCode(userId: string): string | undefined {
    return this.identificationCodes.get(userId);
  }

  /**
   * 使用识别码计算JRRP值
   * @param code 识别码
   * @param date 日期
   * @param password 密码
   * @returns JRRP值(0-100)
   */
  calculateJrrpWithCode(code: string, date: Date, password: string): number {
    const dayOfYear = this.getDayOfYear(date);
    const year = date.getFullYear();
    const day = date.getDate();

    const hash1 = this.getHash([
      'asdfgbn',
      String(dayOfYear),
      '12#3$45',
      String(year),
      'IUY'
    ].join(''));

    const hash2 = this.getHash([
      password,
      code,
      '0*8&6',
      String(day),
      'kjhg'
    ].join(''));

    const divisorThree = BigInt(3);
    const mergedHash = (hash1 / divisorThree + hash2 / divisorThree);
    const normalizedHash = Math.abs(Number(mergedHash) / 527.0);
    const randomValue = Math.round(normalizedHash) % 1001;

    return randomValue >= 970 ? 100 : Math.round((randomValue / 969.0) * 99.0);
  }

  /**
   * 获取指定数字对应的数学表达式
   * @param n - 需要获取表达式的数字
   * @param baseNumber - 用于生成表达式的基础数字
   * @returns 返回对应数字的表达式字符串
   */
  private getDigitExpr(n: number, baseNumber: number): string {
    if (!this.expressionsInitialized) {
      const b = baseNumber;
      this.digitExpressions.set(b, String(b));

      // 设置1-9的数字表达式
      for (let i = 1; i <= 9; i++) {
        if (i === b) continue;
        if (i <= 9) {
          this.digitExpressions.set(i, String(b === i ? b : i));
        }
      }

      // 设置需要特殊处理的数字
      this.digitExpressions.set(0, `(${b} ^ ${b})`);
      this.digitExpressions.set(10, `((${b} << ${b} / ${b}) + (${b} >> ${b} / ${b}))`);

      // 如果基础数字不是对应数字，设置特殊表达式
      if (b !== 1) this.digitExpressions.set(1, `(${b} / ${b})`);
      if (b !== 2) this.digitExpressions.set(2, `(${b} >> (${b} / ${b})`);
      if (b !== 3) this.digitExpressions.set(3, `(${b} / (${b} / ${b} << ${b} / ${b}))`);
      if (b !== 4) this.digitExpressions.set(4, `(${b} & (${b} | (${b} / ${b})))`);
      if (b !== 5) this.digitExpressions.set(5, `(${b} - ${b} / ${b})`);
      if (b !== 6) this.digitExpressions.set(6, `(${b} + (${b} / ${b} >> ${b} / ${b}))`);
      if (b !== 7) this.digitExpressions.set(7, `(${b} + ${b} / ${b})`);
      if (b !== 8) this.digitExpressions.set(8, `(${b} + ${b} / ${b} << ${b} / ${b})`);
      if (b !== 9) this.digitExpressions.set(9, `(${b} | (${b} >> ${b} / ${b}))`);

      this.expressionsInitialized = true;
    }

    return this.digitExpressions.get(n) || String(n);
  }

  /**
   * 使用十进制形式生成目标数值的表达式
   * @param target - 目标数值
   * @param baseNumber - 基础数字
   * @returns 返回一个基于十进制的数学表达式
   */
  private generateDecimalExpression(target: number, baseNumber: number): string {
    // 处理特殊情况和缓存
    if (target <= 10) return this.getDigitExpr(target, baseNumber);
    const cached = this.digitExpressions.get(target);
    if (cached) return cached;

    // 处理100的特殊情况
    if (target === 100) {
      const expr = `(${this.getDigitExpr(10, baseNumber)} * ${this.getDigitExpr(10, baseNumber)})`;
      this.digitExpressions.set(100, expr);
      return expr;
    }

    const tens = Math.floor(target / 10);
    const ones = target % 10;

    // 生成表达式
    let expr: string;
    if (target <= 20) {
      // 11-20的数字使用加法表示
      expr = `(${this.getDigitExpr(10, baseNumber)} + ${this.getDigitExpr(ones, baseNumber)})`;
    } else if (ones === 0) {
      // 整十数使用乘法表示
      expr = `(${this.getDigitExpr(tens, baseNumber)} * ${this.getDigitExpr(10, baseNumber)})`;
    } else if (target <= 50) {
      // 50以内的数字使用乘加形式
      expr = `((${this.getDigitExpr(tens, baseNumber)} * ${this.getDigitExpr(10, baseNumber)}) + ${this.getDigitExpr(ones, baseNumber)})`;
    } else {
      // 50以上的数字尝试使用更简洁的表达式
      const nearestTen = tens * 10;
      if (ones <= 5) {
        expr = `(${this.generateDecimalExpression(nearestTen, baseNumber)} + ${this.getDigitExpr(ones, baseNumber)})`;
      } else {
        const nextTen = (tens + 1) * 10;
        expr = `(${this.generateDecimalExpression(nextTen, baseNumber)} - ${this.getDigitExpr(10 - ones, baseNumber)})`;
      }
    }

    // 缓存生成的表达式
    this.digitExpressions.set(target, expr);
    return expr;
  }

  /**
   * 使用质因数分解的方式生成目标数值的表达式
   * @param target - 目标数值
   * @param baseNumber - 基础数字
   * @returns 返回一个基于质因数分解的数学表达式
   */
  private generatePrimeFactorsExpression(target: number, baseNumber: number): string {
    // 处理10以内的数字直接返回表达式
    if (target <= 10) return this.getDigitExpr(target, baseNumber);

    // 检查是否在预设表达式中
    const expr = this.digitExpressions.get(target);
    if (expr) return expr;
    if (target === 100) return `(${this.getDigitExpr(10, baseNumber)} * ${this.getDigitExpr(10, baseNumber)})`;

    // 递归分解函数
    const decompose = (num: number): string => {
      if (num <= 10) return this.getDigitExpr(num, baseNumber);

      const predefinedExpr = this.digitExpressions.get(num);
      if (predefinedExpr) return predefinedExpr;

      // 尝试因式分解
      for (let i = Math.min(9, Math.floor(Math.sqrt(num))); i >= 2; i--) {
        if (num % i === 0) {
          const quotient = num / i;
          if (quotient <= 10) {
            return `(${this.getDigitExpr(i, baseNumber)} * ${this.getDigitExpr(quotient, baseNumber)})`;
          }
          // 递归分解较大的因子
          return `(${this.getDigitExpr(i, baseNumber)} * ${decompose(quotient)})`;
        }
      }

      // 无法分解时使用加减法
      const base = Math.floor(num / 10) * 10;
      const diff = num - base;
      if (diff === 0) {
        return decompose(num / 10) + ` * ${this.getDigitExpr(10, baseNumber)}`;
      }
      return diff > 0
        ? `(${decompose(base)} + ${this.getDigitExpr(diff, baseNumber)})`
        : `(${decompose(base)} - ${this.getDigitExpr(-diff, baseNumber)})`;
    };

    return decompose(target);
  }

  /**
   * 使用混合运算生成目标数值的表达式
   * @param target - 目标数值
   * @param baseNumber - 基础数字
   * @returns 返回一个包含多种运算的数学表达式
   */
  private generateMixedOperationsExpression(target: number, baseNumber: number): string {
    if (target <= 10) return this.getDigitExpr(target, baseNumber);

    const cached = this.digitExpressions.get(target);
    if (cached) return cached;

    const b = this.getDigitExpr(baseNumber, baseNumber);
    let expr = '';

    if (target === 0) {
      expr = `(${b} - ${b})`;
    } else if (target === 100) {
      expr = `(${b} * ${this.generateMixedOperationsExpression(Math.floor(100/baseNumber), baseNumber)})`;
    } else {
      const strategies = [
        // 加减法策略 - 保持不变
        () => {
          const base = Math.floor(target / 10) * 10;
          const diff = target - base;
          return diff >= 0
            ? `(${this.generateMixedOperationsExpression(base, baseNumber)} + ${this.getDigitExpr(diff, baseNumber)})`
            : `(${this.generateMixedOperationsExpression(base, baseNumber)} - ${this.getDigitExpr(-diff, baseNumber)})`;
        },
        // 改进的乘除法策略
        () => {
          // 找到最接近的能被基数整除的数
          const quotient = Math.floor(target / baseNumber);
          const remainder = target % baseNumber;

          if (remainder === 0) {
            // 能整除的情况
            return `(${b} * ${this.generateMixedOperationsExpression(quotient, baseNumber)})`;
          } else if (remainder <= baseNumber / 2) {
            // 余数较小时，使用加法
            return `((${b} * ${this.generateMixedOperationsExpression(quotient, baseNumber)}) + ${this.getDigitExpr(remainder, baseNumber)})`;
          } else {
            // 余数较大时，使用减法（向上取整）
            return `((${b} * ${this.generateMixedOperationsExpression(quotient + 1, baseNumber)}) - ${this.getDigitExpr(baseNumber - remainder, baseNumber)})`;
          }
        },
        // 改进的位运算策略，处理余数
        () => {
          const maxShift = Math.floor(Math.log2(target));
          const base = 1 << maxShift;
          const remainder = target - base;

          if (remainder === 0) {
            return `(${b} << ${this.getDigitExpr(maxShift, baseNumber)})`;
          } else if (remainder < 0) {
            // 如果目标值小于2的幂，使用减法
            return `((${b} << ${this.getDigitExpr(maxShift, baseNumber)}) - ${this.generateMixedOperationsExpression(-remainder, baseNumber)})`;
          } else {
            // 如果有余数，递归处理余数部分
            return `((${b} << ${this.getDigitExpr(maxShift, baseNumber)}) + ${this.generateMixedOperationsExpression(remainder, baseNumber)})`;
          }
        },
        // 新增：递归分解策略
        () => {
          // 尝试找到最接近的可以简单表示的数
          for (let i = 1; i <= Math.min(10, target); i++) {
            if (target % i === 0) {
              const quotient = target / i;
              if (quotient <= 10) {
                return `(${this.getDigitExpr(i, baseNumber)} * ${this.getDigitExpr(quotient, baseNumber)})`;
              }
            }
          }
          // 如果找不到合适的因子，使用加减法
          const mid = Math.floor(target / 2);
          return `(${this.generateMixedOperationsExpression(mid, baseNumber)} + ${this.generateMixedOperationsExpression(target - mid, baseNumber)})`;
        }
      ];

      expr = strategies[Math.floor(Math.random() * strategies.length)]();
    }

    this.digitExpressions.set(target, expr);
    return expr;
  }

  /**
   * 根据娱乐模式设置格式化分数显示
   */
  public formatScore(score: number, date: Date, foolConfig: FoolConfig): string {
    const isValidFoolDate = () => {
      if (!foolConfig.date) return true;
      const [month, day] = foolConfig.date.split('-').map(Number);
      return date.getMonth() + 1 === month && date.getDate() === day;
    };

    if (foolConfig.type !== FoolMode.ENABLED || !isValidFoolDate()) {
      return score.toString();
    }

    try {
      switch (foolConfig.displayMode) {
        case DisplayMode.BINARY:
          return score.toString(2);
        case DisplayMode.EXPRESSION:
          const baseNumber = foolConfig.baseNumber ?? 6;
          const rand = Math.random();
          if (rand < 0.33) {
            return this.generateDecimalExpression(score, baseNumber);
          } else if (rand < 0.66) {
            return this.generatePrimeFactorsExpression(score, baseNumber);
          } else {
            return this.generateMixedOperationsExpression(score, baseNumber);
          }
        default:
          return score.toString();
      }
    } catch (error) {
      this.ctx.logger.error('Error formatting score:', error);
      return score.toString();
    }
  }
}
