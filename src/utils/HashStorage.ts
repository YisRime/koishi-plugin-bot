import { Logger } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { ImageHasher } from './ImageHasher';
import { FileHandler } from './fileHandler';

const logger = new Logger('HashStorage');

// 接口定义
interface HashData {
  hashes: Record<string, string>;
  lastUpdated?: string;
}

interface HashStatus {
  lastUpdated: string;
  entries: Array<{ caveId: number; hash: string }>;
}

export class HashStorage {
  private static readonly HASH_FILE = 'hash.json';
  private hashes = new Map<number, string>();
  private initialized = false;

  constructor(private readonly caveDir: string) {}

  // 路径获取器
  private get filePath() {
    return path.join(this.caveDir, HashStorage.HASH_FILE);
  }

  private get resourceDir() {
    return path.join(this.caveDir, 'resources');
  }

  // 核心初始化方法
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const hashData = await FileHandler.readJsonData<HashData>(this.filePath)
        .then(data => data[0])
        .catch(() => null);

      const needsRebuild = !hashData?.hashes || Object.keys(hashData.hashes).length === 0;

      if (needsRebuild) {
        await this.buildInitialHashes();
      } else {
        this.hashes = new Map(
          Object.entries(hashData.hashes).map(([k, v]) => [Number(k), v as string])
        );
        await this.updateMissingHashes();
      }

      this.initialized = true;
      logger.success(`Hash存储初始化完成，共加载 ${this.hashes.size} 个hash值`);
    } catch (error) {
      logger.error(`初始化失败: ${error.message}`);
      this.initialized = true;
    }
  }

  // 状态查询方法
  async getStatus(): Promise<HashStatus> {
    if (!this.initialized) await this.initialize();

    return {
      lastUpdated: new Date().toISOString(),
      entries: Array.from(this.hashes.entries()).map(([caveId, hash]) => ({
        caveId,
        hash
      }))
    };
  }

  // 哈希更新方法
  async updateCaveHash(caveId: number, imgBuffer?: Buffer): Promise<void> {
    if (!this.initialized) await this.initialize();

    try {
      if (imgBuffer) {
        const hash = await ImageHasher.calculateHash(imgBuffer);
        this.hashes.set(caveId, hash);
      } else {
        this.hashes.delete(caveId);
      }
      await this.saveHashes();
    } catch (error) {
      logger.error(`更新哈希失败 (cave ${caveId}): ${error.message}`);
    }
  }

  async updateAllCaves(caveFilePath: string, resourceDir: string): Promise<void> {
    if (!this.initialized) await this.initialize();

    try {
      logger.info('开始全量更新图片哈希...');
      const caveData = await this.loadCaveData();

      this.hashes.clear();
      let processedCount = 0;
      let totalImages = caveData.filter(cave =>
        cave.elements?.some(el => el.type === 'img' && el.file)
      ).length;

      for (const cave of caveData) {
        const imgElement = cave.elements?.find(el => el.type === 'img' && el.file);
        if (!imgElement?.file) continue;

        try {
          const filePath = path.join(resourceDir, imgElement.file);
          if (!fs.existsSync(filePath)) {
            logger.warn(`图片文件不存在: ${filePath}`);
            continue;
          }

          const imgBuffer = await fs.promises.readFile(filePath);
          const hash = await ImageHasher.calculateHash(imgBuffer);
          this.hashes.set(cave.cave_id, hash);
          processedCount++;

          if (processedCount % 10 === 0) {
            logger.info(`处理进度: ${processedCount}/${totalImages}`);
          }
        } catch (error) {
          logger.error(`处理回声洞 ${cave.cave_id} 失败: ${error.message}`);
        }
      }

      await this.saveHashes();
      logger.success(`全量更新完成，共处理 ${processedCount}/${totalImages} 个图片`);
    } catch (error) {
      logger.error(`全量更新失败: ${error.message}`);
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

    return Promise.all(
      imgBuffers.map(async (buffer, index) => {
        try {
          const hash = await ImageHasher.calculateHash(buffer);
          let maxSimilarity = 0;
          let matchedCaveId = null;

          for (const [caveId, existingHash] of this.hashes) {
            const similarity = ImageHasher.calculateSimilarity(hash, existingHash);
            if (similarity >= threshold && similarity > maxSimilarity) {
              maxSimilarity = similarity;
              matchedCaveId = caveId;
            }
          }

          return matchedCaveId ? { index, caveId: matchedCaveId, similarity: maxSimilarity } : null;
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
    const caveFilePath = path.join(this.caveDir, 'cave.json');
    const data = await FileHandler.readJsonData<Array<{
      cave_id: number;
      elements: Array<{ type: string; file?: string }>;
    }>>(caveFilePath);
    return data ? data.flat() : [];
  }

  private async saveHashes(): Promise<void> {
    const data: HashData = {
      hashes: Object.fromEntries(this.hashes),
      lastUpdated: new Date().toISOString()
    };
    await FileHandler.writeJsonData(this.filePath, [data]);
  }

  private async buildInitialHashes(): Promise<void> {
    logger.info('开始构建图片hash数据...');
    this.hashes.clear();
    await this.updateAllCaves(path.join(this.caveDir, 'cave.json'), this.resourceDir);
  }

  private async updateMissingHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let updatedCount = 0;

    for (const cave of caveData) {
      if (this.hashes.has(cave.cave_id)) continue;

      const imgElement = cave.elements.find(el => el.type === 'img' && el.file);
      if (!imgElement?.file) continue;

      try {
        const filePath = path.join(this.resourceDir, imgElement.file);
        if (!fs.existsSync(filePath)) continue;

        const imgBuffer = await fs.promises.readFile(filePath);
        const hash = await ImageHasher.calculateHash(imgBuffer);
        this.hashes.set(cave.cave_id, hash);
        updatedCount++;
      } catch (error) {
        logger.error(`处理回声洞 ${cave.cave_id} 失败: ${error.message}`);
      }
    }

    if (updatedCount > 0) {
      await this.saveHashes();
      logger.success(`已更新 ${updatedCount} 个新的hash值`);
    }
  }
}
