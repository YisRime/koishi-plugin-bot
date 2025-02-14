import { Logger } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { ImageHasher } from './ImageHasher';
import { FileHandler } from './fileHandler';

const logger = new Logger('HashStorage');

interface HashData {
  hashes: Record<string, string>;
}

export class HashStorage {
  private static readonly HASH_FILE = 'hash.json';
  private hashes = new Map<number, string>();
  private initialized = false;

  constructor(private readonly caveDir: string) {}

  private get filePath() {
    return path.join(this.caveDir, HashStorage.HASH_FILE);
  }

  private get resourceDir() {
    return path.join(this.caveDir, 'resources');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const hashData = await FileHandler.readJsonData<HashData>(this.filePath)
        .then(data => data[0])
        .catch(() => null);

      // 检查hash文件是否存在并有效
      const needsRebuild = !hashData?.hashes || Object.keys(hashData.hashes).length === 0;

      if (needsRebuild) {
        // 如果没有hash数据或者为空，进行完整重建
        await this.buildInitialHashes();
      } else {
        // 有现有数据，加载并验证
        this.hashes = new Map(
          Object.entries(hashData.hashes).map(([k, v]) => [Number(k), v as string])
        );

        // 检查是否需要更新（例如有新图片但没有对应的hash）
        await this.updateMissingHashes();
      }

      this.initialized = true;
      logger.success(`Hash存储初始化完成，共加载 ${this.hashes.size} 个hash值`);
    } catch (error) {
      logger.error(`初始化失败: ${error.message}`);
      this.initialized = true; // 即使失败也标记为已初始化，避免重复尝试
    }
  }

  private async updateMissingHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let updatedCount = 0;

    for (const cave of caveData) {
      // 如果cave_id已经有hash，跳过
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

  private async loadCaveData(): Promise<Array<{
    cave_id: number;
    elements: Array<{ type: string; file?: string }>;
  }>> {
    const caveFilePath = path.join(this.caveDir, 'cave.json');
    return (await FileHandler.readJsonData<Array<{
      cave_id: number;
      elements: Array<{ type: string; file?: string }>;
    }>>(caveFilePath))[0];
  }

  private async buildInitialHashes(): Promise<void> {
    logger.info('开始构建图片hash数据...');
    this.hashes.clear();

    const caveData = await this.loadCaveData();
    let processedCount = 0;
    const totalImages = caveData.filter(cave =>
      cave.elements.some(el => el.type === 'img' && el.file)
    ).length;

    for (const cave of caveData) {
      const imgElement = cave.elements.find(el => el.type === 'img' && el.file);
      if (!imgElement?.file) continue;

      try {
        const filePath = path.join(this.resourceDir, imgElement.file);
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
    logger.success(`初始哈希构建完成，共处理 ${this.hashes.size}/${totalImages} 个图片`);
  }

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

  private async saveHashes(): Promise<void> {
    const data: HashData = {
      hashes: Object.fromEntries(this.hashes)
    };

    await FileHandler.writeJsonData(this.filePath, [data]);
  }

  async findDuplicates(imgBuffers: Buffer[], threshold: number): Promise<Array<{ index: number; caveId: number; similarity: number } | null>> {
    if (!this.initialized) await this.initialize();

    const results = await Promise.all(
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

    return results;
  }

  // 新增方法:检查并保存图片
  async checkAndSaveImage(
    buffer: Buffer,
    caveId: number,
    filePath: string,
    threshold: number
  ): Promise<{ isDuplicate: boolean; similarity: number; duplicateCaveId?: number }> {
    if (!this.initialized) await this.initialize();

    try {
      const hash = await ImageHasher.calculateHash(buffer);
      let maxSimilarity = 0;
      let duplicateCaveId = null;

      // 检查是否存在相似图片
      for (const [existingCaveId, existingHash] of this.hashes) {
        const similarity = ImageHasher.calculateSimilarity(hash, existingHash);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          duplicateCaveId = existingCaveId;
        }
      }

      // 如果没有超过阈值的重复,则保存图片和哈希
      if (maxSimilarity < threshold) {
        await FileHandler.saveMediaFile(filePath, buffer);
        await this.updateCaveHash(caveId, buffer);
        return { isDuplicate: false, similarity: maxSimilarity };
      }

      return {
        isDuplicate: true,
        similarity: maxSimilarity,
        duplicateCaveId
      };
    } catch (error) {
      logger.error(`处理图片失败: ${error.message}`);
      throw error;
    }
  }
}
