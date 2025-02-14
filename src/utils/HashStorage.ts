import { Logger } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { ImageHasher } from './ImageHasher';
import { FileHandler } from './fileHandler';
import { promisify } from 'util';

const logger = new Logger('HashStorage');
const readFileAsync = promisify(fs.readFile);

// 接口定义
interface HashData {
  hashes: Record<string, string[]>;  // 改为字符串数组
  lastUpdated?: string;
}

interface HashStatus {
  lastUpdated: string;
  entries: Array<{ caveId: number; hashes: string[] }>;  // 改为数组
}

export class HashStorage {
  private static readonly HASH_FILE = 'hash.json';
  private static readonly CAVE_FILE = 'cave.json';
  private static readonly BATCH_SIZE = 50; // 批量处理大小
  private hashes = new Map<number, string[]>();  // 改为字符串数组
  private initialized = false;

  constructor(private readonly caveDir: string) {}

  // 路径获取器
  private get filePath() {
    return path.join(this.caveDir, HashStorage.HASH_FILE);
  }

  private get resourceDir() {
    return path.join(this.caveDir, 'resources');
  }

  private get caveFilePath() {
    return path.join(this.caveDir, HashStorage.CAVE_FILE);
  }

  // 核心初始化方法
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const hashData = await FileHandler.readJsonData<HashData>(this.filePath)
        .then(data => data[0])
        .catch(() => null);

      if (!hashData?.hashes || Object.keys(hashData.hashes).length === 0) {
        this.hashes.clear();
        await this.buildInitialHashes();
      } else {
        this.hashes = new Map(
          Object.entries(hashData.hashes).map(([k, v]) => [Number(k), v as string[]])
        );
        await this.updateMissingHashes();
      }

      this.initialized = true;
    } catch (error) {
      logger.error(`Initialization failed: ${error.message}`);
      this.initialized = false;
      throw error;
    }
  }

  // 状态查询方法
  async getStatus(): Promise<HashStatus> {
    if (!this.initialized) await this.initialize();

    return {
      lastUpdated: new Date().toISOString(),
      entries: Array.from(this.hashes.entries()).map(([caveId, hashes]) => ({
        caveId,
        hashes
      }))
    };
  }

  // 哈希更新方法
  async updateCaveHash(caveId: number, imgBuffers?: Buffer[]): Promise<void> {
    if (!this.initialized) await this.initialize();

    try {
      if (imgBuffers?.length) {
        const hashes = await Promise.all(
          imgBuffers.map(buffer => ImageHasher.calculateHash(buffer)) // 直接使用16进制哈希值
        );
        this.hashes.set(caveId, hashes);
      } else {
        this.hashes.delete(caveId);
      }
      await this.saveHashes();
    } catch (error) {
      logger.error(`Failed to update hash (cave ${caveId}): ${error.message}`);
    }
  }

  async updateAllCaves(isInitialBuild: boolean = false): Promise<void> {
    if (!this.initialized && !isInitialBuild) {
      await this.initialize();
      return;
    }

    try {
      logger.info('Starting full hash update...');
      const caveData = await this.loadCaveData();
      const cavesWithImages = caveData.filter(cave =>
        cave.elements?.some(el => el.type === 'img' && el.file)
      );

      this.hashes.clear();
      let processedCount = 0;
      const totalImages = cavesWithImages.length;

      const processCave = async (cave: typeof cavesWithImages[0]) => {
        const imgElement = cave.elements?.find(el => el.type === 'img' && el.file);
        if (!imgElement?.file) return;

        try {
          const filePath = path.join(this.resourceDir, imgElement.file);
          if (!fs.existsSync(filePath)) {
            logger.warn(`Image file not found: ${filePath}`);
            return;
          }

          const imgBuffer = await readFileAsync(filePath);
          const hash = await ImageHasher.calculateHash(imgBuffer);
          this.hashes.set(cave.cave_id, [hash]);
          processedCount++;

          if (processedCount % 100 === 0) {
            logger.info(`Progress: ${processedCount}/${totalImages}`);
          }
        } catch (error) {
          logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
        }
      };

      // 使用批量处理
      await this.processBatch(cavesWithImages, processCave);
      await this.saveHashes();
      logger.success(`Update completed. Processed ${processedCount}/${totalImages} images`);
    } catch (error) {
      logger.error(`Full update failed: ${error.message}`);
      throw error;
    }
  }

  // 重复检查方法
  async findDuplicates(imgBuffers: Buffer[], threshold: number): Promise<Array<{
    index: number;
    caveId: number;
    similarity: number
  } | null>> {
    if (!this.initialized) await this.initialize();

    // 并行计算所有输入图片的哈希值
    const inputHashes = await Promise.all(
      imgBuffers.map(buffer => ImageHasher.calculateHash(buffer))
    );

    const existingHashes = Array.from(this.hashes.entries());

    return Promise.all(
      inputHashes.map(async (hash, index) => {
        try {
          let maxSimilarity = 0;
          let matchedCaveId = null;

          for (const [caveId, hashes] of existingHashes) {
            for (const existingHash of hashes) {
              const similarity = ImageHasher.calculateSimilarity(hash, existingHash);
              // 确保相似度在0-1范围内进行比较
              if (similarity >= threshold && similarity > maxSimilarity) {
                maxSimilarity = similarity;
                matchedCaveId = caveId;
                if (Math.abs(similarity - 1) < Number.EPSILON) break; // 使用更精确的相等性比较
              }
            }
            if (Math.abs(maxSimilarity - 1) < Number.EPSILON) break;
          }

          return matchedCaveId ? {
            index,
            caveId: matchedCaveId,
            similarity: maxSimilarity
          } : null;
        } catch (error) {
          logger.warn(`处理图片 ${index} 失败: ${error.message}`);
          return null;
        }
      })
    );
  }

  // 工具方法
  private async loadCaveData(): Promise<Array<{
    cave_id: number;
    elements: Array<{ type: string; file?: string }>;
  }>> {
    const data = await FileHandler.readJsonData<Array<{
      cave_id: number;
      elements: Array<{ type: string; file?: string }>;
    }>>(this.caveFilePath);
    return Array.isArray(data) ? data.flat() : [];
  }

  private async saveHashes(): Promise<void> {
    const data: HashData = {
      hashes: Object.fromEntries(this.hashes),
      lastUpdated: new Date().toISOString()
    };
    await FileHandler.writeJsonData(this.filePath, [data]);
  }

  private async buildInitialHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let processedCount = 0;
    let totalCaves = caveData.length;

    logger.info(`Building hash data for ${totalCaves} caves...`);

    for (const cave of caveData) {
      const imgElements = cave.elements?.filter(el => el.type === 'img' && el.file) || [];
      if (imgElements.length === 0) continue;

      try {
        const hashes = await Promise.all(
          imgElements.map(async (imgElement) => {
            const filePath = path.join(this.resourceDir, imgElement.file);
            if (!fs.existsSync(filePath)) {
              logger.warn(`Image not found: ${filePath}`);
              return null;
            }
            const imgBuffer = await fs.promises.readFile(filePath);
            const hash = await ImageHasher.calculateHash(imgBuffer);
            return hash; // 直接返回16进制哈希值
          })
        );

        const validHashes = hashes.filter(hash => hash !== null);
        if (validHashes.length > 0) {
          this.hashes.set(cave.cave_id, validHashes);
        }

        processedCount++;
        if (processedCount % 10 === 0) {
          logger.info(`Progress: ${processedCount}/${totalCaves}`);
        }
      } catch (error) {
        logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
      }
    }

    await this.saveHashes();
    logger.success(`Build completed. Processed ${processedCount}/${totalCaves} caves`);
  }

  private async updateMissingHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let updatedCount = 0;

    for (const cave of caveData) {
      if (this.hashes.has(cave.cave_id)) continue;

      const imgElements = cave.elements?.filter(el => el.type === 'img' && el.file) || [];
      if (imgElements.length === 0) continue;

      try {
        const hashes = await Promise.all(
          imgElements.map(async (imgElement) => {
            const filePath = path.join(this.resourceDir, imgElement.file);
            if (!fs.existsSync(filePath)) {
              return null;
            }
            const imgBuffer = await fs.promises.readFile(filePath);
            return ImageHasher.calculateHash(imgBuffer);
          })
        );

        const validHashes = hashes.filter(hash => hash !== null);
        if (validHashes.length > 0) {
          this.hashes.set(cave.cave_id, validHashes);
          updatedCount++;
        }
      } catch (error) {
        logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
      }
    }

    if (updatedCount > 0) {
      await this.saveHashes();
      logger.info(`Updated ${updatedCount} new hashes`);
    }
  }

  private async processBatch<T>(
    items: T[],
    processor: (item: T) => Promise<void>,
    batchSize = HashStorage.BATCH_SIZE
  ): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async item => {
          try {
            await processor(item);
          } catch (error) {
            logger.error(`Batch processing error: ${error.message}`);
          }
        })
      );
    }
  }
}
