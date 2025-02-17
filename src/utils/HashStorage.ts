import { Logger } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { ImageHasher } from './ImageHasher';
import { FileHandler } from './fileHandler';
import crypto from 'crypto';

const logger = new Logger('HashStorage');

/**
 * 存储哈希值的数据接口
 * @interface HashData
 */
interface HashData {
  /** 图像哈希值记录 */
  imageHashes: Record<string, string[]>;
  /** 文本哈希值记录 */
  textHashes: Record<string, string[]>;
  /** 最后更新时间 */
  lastUpdated: string;
}

/**
 * 哈希存储管理类
 * @class HashStorage
 */
export class HashStorage {
  private readonly filePath: string;
  private readonly resourceDir: string;
  private readonly caveFilePath: string;
  private imageHashes = new Map<number, string[]>();
  private textHashes = new Map<number, string[]>();
  private initialized = false;

  /**
   * 创建哈希存储实例
   * @param caveDir - 回声洞数据目录路径
   */
  constructor(private readonly caveDir: string) {
    this.filePath = path.join(caveDir, 'hash.json');
    this.resourceDir = path.join(caveDir, 'resources');
    this.caveFilePath = path.join(caveDir, 'cave.json');
  }

  /**
   * 初始化哈希存储
   * @throws 初始化失败时抛出错误
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const hashData = await FileHandler.readJsonData<HashData>(this.filePath)
        .then(data => data[0])
        .catch(() => null);

      if (!hashData?.imageHashes) {
        await this.buildInitialHashes();
      } else {
        this.loadHashData(hashData);
        const stats = this.getStorageStats();
        logger.info(`Loaded ${stats.text} text hashes and ${stats.image} image hashes from storage`);
        await this.updateMissingHashes();
      }

      this.initialized = true;
    } catch (error) {
      logger.error(`Hash storage initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * 加载哈希数据
   * @param data - 要加载的哈希数据
   * @private
   */
  private loadHashData(data: HashData): void {
    this.imageHashes = new Map(Object.entries(data.imageHashes).map(([k, v]) => [Number(k), v]));
    this.textHashes = new Map(Object.entries(data.textHashes || {}).map(([k, v]) => [Number(k), v]));
  }

  /**
   * 更新指定回声洞的哈希值
   * @param caveId - 回声洞ID
   * @param type - 哈希类型（图像或文本）
   * @param content - 要计算哈希的内容
   */
  async updateHash(caveId: number, type: 'image' | 'text', content: Buffer | string): Promise<void> {
    if (!this.initialized) await this.initialize();

    try {
      const hash = type === 'image'
        ? await ImageHasher.calculateHash(content as Buffer)
        : HashStorage.hashText(content as string);

      const hashMap = type === 'image' ? this.imageHashes : this.textHashes;

      // 确保不重复添加相同的哈希值
      const existingHashes = hashMap.get(caveId) || [];
      if (!existingHashes.includes(hash)) {
        hashMap.set(caveId, [...existingHashes, hash]);
        await this.saveHashes();
      }
    } catch (error) {
      logger.error(`Failed to update ${type} hash for cave ${caveId}: ${error.message}`);
      throw error; // 抛出错误以便上层处理
    }
  }

  /**
   * 查找重复项
   * @param type - 查找类型（图像或文本）
   * @param hashes - 要查找的哈希值数组
   * @param threshold - 相似度阈值，默认为1
   * @returns 匹配结果数组
   */
  async findDuplicates(type: 'image' | 'text', hashes: string[], threshold: number = 1): Promise<Array<{
    index: number;
    caveId: number;
    similarity: number;
  } | null>> {
    if (!this.initialized) await this.initialize();

    const hashMap = type === 'image' ? this.imageHashes : this.textHashes;
    const calculateSimilarity = type === 'image'
      ? (a: string, b: string) => {
          try {
            return ImageHasher.calculateSimilarity(a, b);
          } catch (error) {
            logger.debug(`Failed to calculate similarity: ${error.message}`);
            return 0;
          }
        }
      : (a: string, b: string) => a === b ? 1 : 0;

    return hashes.map((hash, index) => {
      if (!hash) return null;

      let maxSimilarity = 0;
      let matchedCaveId = null;

      for (const [caveId, existingHashes] of hashMap.entries()) {
        for (const existingHash of existingHashes) {
          if (!existingHash) continue;

          const similarity = calculateSimilarity(hash, existingHash);
          if (similarity >= threshold && similarity > maxSimilarity) {
            maxSimilarity = similarity;
            matchedCaveId = caveId;
            if (similarity === 1) break;
          }
        }
        if (maxSimilarity === 1) break;
      }

      return matchedCaveId ? { index, caveId: matchedCaveId, similarity: maxSimilarity } : null;
    });
  }

  /**
   * 通过Buffer或者字符串计算哈希并查找重复
   * @param type - 查找类型（图像或文本）
   * @param content - 要查找的内容，可以是Buffer数组或字符串数组
   * @param threshold - 相似度阈值，默认为1
   */
  async findDuplicatesFromContent(
    type: 'image' | 'text',
    content: Array<Buffer | string>,
    threshold: number = 1
  ): Promise<Array<{
    index: number;
    caveId: number;
    similarity: number;
  } | null>> {
    const hashes = await Promise.all(
      content.map(async item => {
        if (type === 'image' && item instanceof Buffer) {
          return await ImageHasher.calculateHash(item);
        } else if (type === 'text' && typeof item === 'string') {
          return HashStorage.hashText(item);
        }
        return null;
      })
    );

    return this.findDuplicates(type, hashes.filter(Boolean), threshold);
  }

  /**
   * 清除指定回声洞的所有哈希值
   * @param caveId - 回声洞ID
   */
  async clearHashes(caveId: number): Promise<void> {
    if (!this.initialized) await this.initialize();

    const wasDeleted = this.imageHashes.delete(caveId) || this.textHashes.delete(caveId);
    if (wasDeleted) {
      await this.saveHashes();
    }
  }

  /**
   * 构建初始哈希值
   * @private
   */
  private async buildInitialHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let processedCount = 0;
    const total = caveData.length;

    for (const cave of caveData) {
      await this.processCaveHashes(cave);
      await this.processCaveTextHashes(cave);
      processedCount++;

      if (processedCount % 100 === 0 || processedCount === total) {
        logger.info(`Initializing: ${processedCount}/${total} caves (${Math.floor(processedCount / total * 100)}%)`);
      }
    }

    await this.saveHashes();
    const stats = this.getStorageStats();
    logger.info(`Initialization complete: ${stats.text} text hashes and ${stats.image} image hashes generated`);
  }

  /**
   * 更新缺失的哈希值
   * @private
   */
  private async updateMissingHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    const existingCaveIds = new Set(caveData.map(cave => cave.cave_id));

    // 清理已不存在的回声洞的哈希
    for (const caveId of this.imageHashes.keys()) {
      if (!existingCaveIds.has(caveId)) {
        this.imageHashes.delete(caveId);
      }
    }
    for (const caveId of this.textHashes.keys()) {
      if (!existingCaveIds.has(caveId)) {
        this.textHashes.delete(caveId);
      }
    }

    const missingImageCaves = caveData.filter(cave => !this.imageHashes.has(cave.cave_id));
    const missingTextCaves = caveData.filter(cave => !this.textHashes.has(cave.cave_id));
    const total = missingImageCaves.length + missingTextCaves.length;

    if (total > 0 || !existingCaveIds.size) {
      const oldStats = this.getStorageStats();
      let updated = false;

      for (const cave of missingImageCaves) {
        await this.processCaveHashes(cave);
        updated = true;
      }

      for (const cave of missingTextCaves) {
        await this.processCaveTextHashes(cave);
        updated = true;
      }

      if (updated || !existingCaveIds.size) {
        await this.saveHashes();
        const newStats = this.getStorageStats();
        logger.info(`Update complete: text hashes ${oldStats.text} → ${newStats.text}, image hashes ${oldStats.image} → ${newStats.image}`);
      }
    }
  }

  /**
   * 处理单个回声洞的哈希值
   * @param cave - 回声洞数据
   * @private
   */
  private async processCaveHashes(cave: any): Promise<void> {
    const imgElements = cave.elements?.filter(el => el.type === 'img' && el.file) || [];
    if (imgElements.length === 0) return;

    try {
      const hashes = await Promise.all(imgElements.map(async el => {
        const filePath = path.join(this.resourceDir, el.file);
        return fs.existsSync(filePath)
          ? ImageHasher.calculateHash(await fs.promises.readFile(filePath))
          : null;
      }));

      const validHashes = hashes.filter(Boolean);
      if (validHashes.length) {
        this.imageHashes.set(cave.cave_id, validHashes);
        await this.saveHashes();
      }
    } catch (error) {
      logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
    }
  }

  private async processCaveTextHashes(cave: any): Promise<void> {
    const textElements = cave.elements?.filter(el => el.type === 'text' && el.content) || [];
    if (textElements.length === 0) return;

    try {
      const hashes = textElements.map(el => HashStorage.hashText(el.content));
      if (hashes.length) {
        this.textHashes.set(cave.cave_id, hashes);
      }
    } catch (error) {
      logger.error(`Failed to process text hashes for cave ${cave.cave_id}: ${error.message}`);
    }
  }

  /**
   * 保存哈希数据到文件
   * @private
   */
  private async saveHashes(): Promise<void> {
    try {
      const data: HashData = {
        imageHashes: Object.fromEntries(this.imageHashes),
        textHashes: Object.fromEntries(this.textHashes),
        lastUpdated: new Date().toISOString()
      };
      await FileHandler.writeJsonData(this.filePath, [data]);
    } catch (error) {
      logger.error(`Failed to save hash data: ${error.message}`);
      throw error;
    }
  }

  /**
   * 加载回声洞数据
   * @returns 回声洞数据数组
   * @private
   */
  private async loadCaveData(): Promise<any[]> {
    const data = await FileHandler.readJsonData(this.caveFilePath);
    return Array.isArray(data) ? data.flat() : [];
  }

  /**
   * 计算文本的哈希值
   * @param text - 要计算哈希的文本
   * @returns MD5哈希值
   */
  static hashText(text: string): string {
    return crypto.createHash('md5').update(text).digest('hex');
  }

  /**
   * 获取存储统计数据
   * @private
   */
  private getStorageStats() {
    const textCount = Array.from(this.textHashes.values()).reduce((sum, arr) => sum + arr.length, 0);
    const imageCount = Array.from(this.imageHashes.values()).reduce((sum, arr) => sum + arr.length, 0);
    return {
      text: textCount,
      image: imageCount
    };
  }
}
