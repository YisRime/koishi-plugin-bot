import { Context, Logger } from 'koishi'
import * as fs from 'fs'
import * as path from 'path'
import { FileHandler } from '../utils/fileHandler'
import { IdManager } from '../utils/idManager'

const logger = new Logger('cave-audit')

// 从index.ts导入类型,而不是从types.ts导入
type Config = import('..').Config
type CaveObject = import('..').CaveObject
type PendingCave = import('..').PendingCave

// 发送审核消息给管理员
export async function sendAuditMessage(
  ctx: Context,
  config: Config,
  cave: PendingCave,
  content: string,
  session: any
) {
  const auditMessage = `${session.text('commands.cave.audit.title')}\n${content}
${session.text('commands.cave.audit.from')}${cave.contributor_number}`

  for (const managerId of config.manager) {
    const bot = ctx.bots[0]
    if (bot) {
      try {
        await bot.sendPrivateMessage(managerId, auditMessage)
      } catch (error) {
        logger.error(session.text('commands.cave.audit.sendFailed', [managerId]))
      }
    }
  }
}

// 处理审核操作
export async function handleAudit(
  pendingData: PendingCave[],
  isApprove: boolean,
  caveFilePath: string,
  resourceDir: string,
  pendingFilePath: string,
  session: any,
  idManager: IdManager,
  targetId?: number
): Promise<string> {
  if (pendingData.length === 0) {
    return session.text('commands.cave.audit.noPending')
  }

  // 处理单条审核
  if (typeof targetId === 'number') {
    const targetCave = pendingData.find(item => item.cave_id === targetId)
    if (!targetCave) {
      return session.text('commands.cave.audit.pendingNotFound')
    }

    const newPendingData = pendingData.filter(item => item.cave_id !== targetId)

    if (isApprove) {
      const oldCaveData = await FileHandler.readJsonData<CaveObject>(caveFilePath)
      const newCaveData = [...oldCaveData, {
        ...targetCave,
        cave_id: targetId,
        elements: cleanElementsForSave(targetCave.elements)
      }]

      await FileHandler.withTransaction([
        {
          filePath: caveFilePath,
          operation: async () => FileHandler.writeJsonData(caveFilePath, newCaveData),
          rollback: async () => FileHandler.writeJsonData(caveFilePath, oldCaveData)
        },
        {
          filePath: pendingFilePath,
          operation: async () => FileHandler.writeJsonData(pendingFilePath, newPendingData),
          rollback: async () => FileHandler.writeJsonData(pendingFilePath, pendingData)
        }
      ])
      await idManager.addStat(targetCave.contributor_number, targetId)
    } else {
      await FileHandler.writeJsonData(pendingFilePath, newPendingData)
      await idManager.markDeleted(targetId)
      await deleteMediaFiles(targetCave, resourceDir)
    }

    const remainingCount = newPendingData.length
    if (remainingCount > 0) {
      const remainingIds = newPendingData.map(c => c.cave_id).join(', ')
      const action = isApprove ? 'auditPassed' : 'auditRejected'
      return session.text('commands.cave.audit.pendingResult', [
        session.text(`commands.cave.audit.${action}`),
        remainingCount,
        remainingIds
      ])
    }
    return session.text(
      isApprove ? 'commands.cave.audit.auditPassed' : 'commands.cave.audit.auditRejected'
    )
  }

  // 处理批量审核
  const data = isApprove ? await FileHandler.readJsonData<CaveObject>(caveFilePath) : null
  let processedCount = 0

  if (isApprove && data) {
    const oldData = [...data]
    const newData = [...data]

    await FileHandler.withTransaction([
      {
        filePath: caveFilePath,
        operation: async () => {
          for (const cave of pendingData) {
            newData.push({
              ...cave,
              cave_id: cave.cave_id,
              elements: cleanElementsForSave(cave.elements)
            })
            processedCount++
            await idManager.addStat(cave.contributor_number, cave.cave_id)
          }
          return FileHandler.writeJsonData(caveFilePath, newData)
        },
        rollback: async () => FileHandler.writeJsonData(caveFilePath, oldData)
      },
      {
        filePath: pendingFilePath,
        operation: async () => FileHandler.writeJsonData(pendingFilePath, []),
        rollback: async () => FileHandler.writeJsonData(pendingFilePath, pendingData)
      }
    ])
  } else {
    for (const cave of pendingData) {
      await idManager.markDeleted(cave.cave_id)
      await deleteMediaFiles(cave, resourceDir)
      processedCount++
    }
    await FileHandler.writeJsonData(pendingFilePath, [])
  }

  return session.text('commands.cave.audit.batchAuditResult', [
    isApprove ? '通过' : '拒绝',
    processedCount,
    pendingData.length
  ])
}

// 删除关联的媒体文件
async function deleteMediaFiles(cave: PendingCave, resourceDir: string) {
  if (cave.elements) {
    for (const element of cave.elements) {
      if ((element.type === 'img' || element.type === 'video') && element.file) {
        const fullPath = path.join(resourceDir, element.file)
        if (fs.existsSync(fullPath)) {
          await fs.promises.unlink(fullPath)
        }
      }
    }
  }
}

// 清理元素数据用于保存
function cleanElementsForSave(elements: any[]): any[] {
  if (!elements?.length) return []

  return elements.map(element => {
    if (element.type === 'text') {
      return {
        type: 'text',
        content: element.content
      }
    } else if (element.type === 'img' || element.type === 'video') {
      return {
        type: element.type,
        file: element.file
      }
    }
    return element
  })
}
