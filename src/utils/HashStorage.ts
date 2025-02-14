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
      const data = await FileHandler.readJsonData<HashData>(this.filePath)
        .then(data => data[0])
        .catch(() => null);

      if (data?.hashes) {
        this.hashes = new Map(
          Object.entries(data.hashes).map(([k, v]) => [Number(k), v as string])
        );
      } else {
        // 如果没有哈希数据，进行初始构建
        await this.buildInitialHashes();
      }

      this.initialized = true;
    } catch (error) {
      logger.error(`初始化失败: ${error.message}`);
      this.initialized = true; // 即使失败也标记为已初始化，避免重复尝试
    }
  }

  private async buildInitialHashes(): Promise<void> {
    const caveFilePath = path.join(this.caveDir, 'cave.json');
    const caveData = (await FileHandler.readJsonData<Array<{
      cave_id: number;
      elements: Array<{ type: string; file?: string }>;
    }>>(caveFilePath))[0];

    for (const cave of caveData) {
      const imgElement = cave.elements.find(el => el.type === 'img' && el.file);
      if (!imgElement?.file) continue;

      const filePath = path.join(this.resourceDir, imgElement.file);
      if (!fs.existsSync(filePath)) continue;

      try {
        const imgBuffer = await fs.promises.readFile(filePath);
        const hash = await ImageHasher.calculateHash(imgBuffer);
        this.hashes.set(cave.cave_id, hash);
      } catch (error) {
        logger.error(`处理回声洞 ${cave.cave_id} 失败: ${error.message}`);
      }
    }

    await this.saveHashes();
    logger.success(`初始哈希构建完成，共处理 ${this.hashes.size} 个图片`);
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
