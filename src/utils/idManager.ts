import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'koishi';
import { FileHandler } from './fileHandler';

const logger = new Logger('idManager');

// 定义接口
interface CaveObject {
  cave_id: number;
  contributor_number: string;
  // ...其他属性
}

interface PendingCave extends CaveObject {}

/**
 * ID管理器
 * @description 负责cave ID的分配、回收和持久化
 */
export class IdManager {
  private deletedIds: Set<number> = new Set();
  private maxId: number = 0;
  private initialized: boolean = false;
  private readonly statusFilePath: string;
  private stats: Record<string, number[]> = {};
  private usedIds: Set<number> = new Set();

  constructor(baseDir: string) {
    const caveDir = path.join(baseDir, 'data', 'cave');
    this.statusFilePath = path.join(caveDir, 'status.json');
  }

  async initialize(caveFilePath: string, pendingFilePath: string) {
    if (this.initialized) return;

    try {
      // 避免重复初始化
      if (!this.initialized) {
        // 读取状态文件
        const status = fs.existsSync(this.statusFilePath) ?
          JSON.parse(await fs.promises.readFile(this.statusFilePath, 'utf8')) : {
            deletedIds: [],
            maxId: 0,
            stats: {},
            lastUpdated: new Date().toISOString()
          };

        const [caveData, pendingData] = await Promise.all([
          FileHandler.readJsonData<CaveObject>(caveFilePath),
          FileHandler.readJsonData<PendingCave>(pendingFilePath)
        ]);

        this.usedIds.clear();
        const conflicts = new Map<number, Array<CaveObject | PendingCave>>();

        // 收集和处理ID
        const processItems = (items: Array<CaveObject | PendingCave>) => {
          items.forEach(item => {
            if (this.usedIds.has(item.cave_id)) {
              if (!conflicts.has(item.cave_id)) {
                conflicts.set(item.cave_id, []);
              }
              conflicts.get(item.cave_id)?.push(item);
            } else {
              this.usedIds.add(item.cave_id);
            }
          });
        };

        processItems(caveData);
        processItems(pendingData);

        // 处理冲突
        if (conflicts.size > 0) {
          logger.warn(`Found ${conflicts.size} ID conflicts, auto-fixing...`);
          for (const items of conflicts.values()) {
            items.slice(1).forEach(item => {
              let newId = this.maxId + 1;
              while (this.usedIds.has(newId)) {
                newId++;
              }
              logger.info(`Reassigning ID ${item.cave_id} -> ${newId} for item`);
              item.cave_id = newId;
              this.usedIds.add(newId);
              this.maxId = Math.max(this.maxId, newId);
            });
          }

          await Promise.all([
            FileHandler.writeJsonData(caveFilePath, caveData),
            FileHandler.writeJsonData(pendingFilePath, pendingData)
          ]);
        }

        // 更新maxId
        this.maxId = Math.max(
          status.maxId || 0,
          ...[...this.usedIds],
          0 // 确保至少为0
        );

        // 更新deletedIds
        this.deletedIds = new Set(
          status.deletedIds?.filter(id => !this.usedIds.has(id)) || []
        );

        // 重新构建stats
        this.stats = {};
        for (const cave of caveData) {
          if (cave.contributor_number === '10000') continue;
          if (!this.stats[cave.contributor_number]) {
            this.stats[cave.contributor_number] = [];
          }
          this.stats[cave.contributor_number].push(cave.cave_id);
        }

        // 确保统计数据更新
        await this.saveStatus();
        this.initialized = true;
      }
    } catch (error) {
      this.initialized = false;
      logger.error(`IdManager initialization failed: ${error.message}`);
      throw error;
    }
  }

  getNextId(): number {
    if (!this.initialized) {
      throw new Error('IdManager not initialized');
    }

    let nextId: number;
    if (this.deletedIds.size === 0) {
      nextId = ++this.maxId;
    } else {
      nextId = Math.min(...Array.from(this.deletedIds));
      this.deletedIds.delete(nextId);
    }

    while (this.usedIds.has(nextId)) {
      nextId = ++this.maxId;
    }

    this.usedIds.add(nextId);

    this.saveStatus().catch(err =>
      logger.error(`Failed to save status after getNextId: ${err.message}`)
    );

    return nextId;
  }

  async markDeleted(id: number) {
    if (!this.initialized) {
      throw new Error('IdManager not initialized');
    }

    this.deletedIds.add(id);
    this.usedIds.delete(id);

    if (id === this.maxId) {
      const maxUsedId = Math.max(...Array.from(this.usedIds));
      this.maxId = maxUsedId;
    }

    await this.saveStatus();
  }

  async addStat(contributorNumber: string, caveId: number) {
    if (contributorNumber === '10000') return;
    if (!this.stats[contributorNumber]) {
      this.stats[contributorNumber] = [];
    }
    this.stats[contributorNumber].push(caveId);
    await this.saveStatus();
  }

  async removeStat(contributorNumber: string, caveId: number) {
    if (this.stats[contributorNumber]) {
      this.stats[contributorNumber] = this.stats[contributorNumber].filter(id => id !== caveId);
      if (this.stats[contributorNumber].length === 0) {
        delete this.stats[contributorNumber];
      }
      await this.saveStatus();
    }
  }

  getStats(): Record<string, number[]> {
    return this.stats;
  }

  private async saveStatus(): Promise<void> {
    try {
      const status = {
        deletedIds: Array.from(this.deletedIds).sort((a, b) => a - b),
        maxId: this.maxId,
        stats: this.stats,
        lastUpdated: new Date().toISOString()
      };

      const tmpPath = `${this.statusFilePath}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(status, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, this.statusFilePath);
    } catch (error) {
      logger.error(`Failed to save status: ${error.message}`);
      throw error;
    }
  }
}
