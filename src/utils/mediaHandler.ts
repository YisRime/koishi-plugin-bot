import * as path from 'path';
import * as fs from 'fs';
import { Context, Logger, h } from 'koishi';
import { Config, CaveObject } from '../index';
import { FileHandler } from './fileHandler';
import { HashStorage } from './HashStorage';
import { IdManager } from './idManager';

const logger = new Logger('mediaHandler');

export interface MediaExtractResult {
  imageUrls: string[];
  imageElements: Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>;
  videoUrls: string[];
  videoElements: Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>;
  textParts: Element[];
}

interface BaseElement {
  type: 'text' | 'img' | 'video';
  index: number;
}

interface TextElement extends BaseElement {
  type: 'text';
  content: string;
}

interface MediaElement extends BaseElement {
  type: 'img' | 'video';
  file?: string;
  fileName?: string;
  fileSize?: string;
  filePath?: string;
}

type Element = TextElement | MediaElement;

// 从原始内容中提取文本、图片和视频元素
export async function extractMediaContent(
  originalContent: string,
  config: Config,
  session: any
): Promise<MediaExtractResult> {
  const textParts = originalContent
    .split(/<(img|video)[^>]+>/)
    .map((text, idx) => text.trim() && ({
      type: 'text' as const,
      content: text.replace(/^(img|video)$/, '').trim(),
      index: idx * 3
    }))
    .filter(text => text && text.content);

  const getMediaElements = (type: 'img' | 'video', maxSize: number) => {
    const regex = new RegExp(`<${type}[^>]+src="([^"]+)"[^>]*>`, 'g');
    const elements: Array<{ type: typeof type; index: number; fileName?: string; fileSize?: string }> = [];
    const urls: string[] = [];

    let match;
    let idx = 0;
    while ((match = regex.exec(originalContent)) !== null) {
      const element = match[0];
      const url = match[1];
      const fileName = element.match(/file="([^"]+)"/)?.[1];
      const fileSize = element.match(/fileSize="([^"]+)"/)?.[1];

      if (fileSize) {
        const sizeInBytes = parseInt(fileSize);
        if (sizeInBytes > maxSize * 1024 * 1024) {
          throw new Error(session.text('commands.cave.message.mediaSizeExceeded', [type]));
        }
      }

      urls.push(url);
      elements.push({
        type,
        index: type === 'video' ? Number.MAX_SAFE_INTEGER : idx * 3 + 1,
        fileName,
        fileSize
      });
      idx++;
    }
    return { urls, elements };
  };

  const { urls: imageUrls, elements: imageElementsRaw } = getMediaElements('img', config.imageMaxSize);
  const imageElements = imageElementsRaw as Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>;
  const { urls: videoUrls, elements: videoElementsRaw } = getMediaElements('video', config.videoMaxSize);
  const videoElements = videoElementsRaw as Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>;

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
}

// 处理媒体文件
export async function processMediaFile(filePath: string, type: 'image' | 'video'): Promise<string | null> {
  const data = await fs.promises.readFile(filePath).catch(() => null);
  if (!data) return null;
  return `data:${type}/${type === 'image' ? 'png' : 'mp4'};base64,${data.toString('base64')}`;
}

// 下载并保存媒体文件到本地
export async function saveMedia(
  urls: string[],
  fileNames: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  mediaType: 'img' | 'video',
  config: Config,
  ctx: Context,
  session: any,
  idManager: IdManager  // 新增参数
): Promise<string[]> {
  const accept = mediaType === 'img' ? 'image/*' : 'video/*';
  const hashStorage = new HashStorage(path.join(ctx.baseDir, 'data', 'cave'));
  await hashStorage.initialize();

  const downloadPromises = urls.map(async (url, i) => {
    const fileName = fileNames[i];
    const ext = path.extname(fileName || url) || (mediaType === 'img' ? '.png' : '.mp4');

    try {
      const response = await ctx.http(decodeURIComponent(url).replace(/&amp;/g, '&'), {
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': accept,
          'Referer': 'https://qq.com'
        }
      });

      if (!response.data) throw new Error('empty_response');
      const buffer = Buffer.from(response.data);
      const baseName = path.basename(fileName || (mediaType === 'img' ? 'image' : 'video'), ext)
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');

      if (config.enableMD5) {
        await checkMD5Duplicates(ctx, resourceDir, baseName, session, caveId, idManager);
      }

      if (mediaType === 'img' && config.enableDuplicate) {
        await checkImageDuplicates(ctx, buffer, config.duplicateThreshold, resourceDir, session, caveId, idManager);
      }

      const finalFileName = `${caveId}_${baseName}${ext}`;
      const filePath = path.join(resourceDir, finalFileName);
      await FileHandler.saveMediaFile(filePath, buffer);

      if (mediaType === 'img' && config.enableDuplicate) {
        try {
          await hashStorage.updateHash(caveId, 'image', buffer);
        } catch (error) {
          logger.debug(`Failed to update image hash: ${error.message}`);
        }
      }

      return finalFileName;

    } catch (error) {
      throw new Error(`Failed to download media: ${error.message}`);
    }
  });

  return await Promise.all(downloadPromises);
}

async function checkMD5Duplicates(
  ctx: Context,
  resourceDir: string,
  baseName: string,
  session: any,
  caveId: number,       // 新增参数
  idManager: IdManager  // 新增参数
) {
  const files = await fs.promises.readdir(resourceDir);
  const duplicateFiles = files.filter(file => {
    const [caveId, nameWithExt] = file.split('_');
    return nameWithExt?.split('.')[0] === baseName;
  });

  for (const file of duplicateFiles) {
    const duplicateCaveId = parseInt(file.split('_')[0]);
    if (isNaN(duplicateCaveId)) continue;

    const caveFilePath = path.join(ctx.baseDir, 'data', 'cave', 'cave.json');
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    const originalCave = data.find(item => item.cave_id === duplicateCaveId);

    if (originalCave) {
      await session.send(session.text('commands.cave.error.exactDuplicateFound') +
        await buildMessage(originalCave, resourceDir, session));
      await idManager.markDeleted(caveId); // 删除已分配的ID
      throw new Error('duplicate_found');
    }
  }
}

async function checkImageDuplicates(
  ctx: Context,
  buffer: Buffer,
  threshold: number,
  resourceDir: string,
  session: any,
  caveId: number,       // 新增参数
  idManager: IdManager  // 新增参数
) {
  const hashStorage = new HashStorage(path.join(ctx.baseDir, 'data', 'cave'));
  const result = await hashStorage.findDuplicates('image', [buffer], threshold);

  if (result.length > 0 && result[0] !== null) {
    const duplicate = result[0];
    const similarity = duplicate.similarity;

    if (similarity >= threshold) {
      const caveFilePath = path.join(ctx.baseDir, 'data', 'cave', 'cave.json');
      const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
      const originalCave = data.find(item => item.cave_id === duplicate.caveId);

      if (originalCave) {
        await session.send(session.text('commands.cave.error.similarDuplicateFound',
          [(similarity * 100).toFixed(1)]) +
          await buildMessage(originalCave, resourceDir, session));
        await idManager.markDeleted(caveId); // 删除已分配的ID
        throw new Error('duplicate_found');
      }
    }
  }
}

// 构建消息内容
export async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  if (!cave?.elements?.length) {
    return session.text('commands.cave.error.noContent');
  }

  const videoElement = cave.elements.find((el): el is MediaElement => el.type === 'video');
  const nonVideoElements = cave.elements
    .filter(el => el.type !== 'video')
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  if (videoElement?.file) {
    const basicInfo = [
      session.text('commands.cave.message.caveTitle', [cave.cave_id]),
      session.text('commands.cave.message.contributorSuffix', [cave.contributor_name])
    ].join('\n');

    await session?.send(basicInfo);

    const filePath = path.join(resourceDir, videoElement.file);
    const base64Data = await processMediaFile(filePath, 'video');
    if (base64Data && session) {
      await session.send(h('video', { src: base64Data }));
    }
    return '';
  }

  const lines = [session.text('commands.cave.message.caveTitle', [cave.cave_id])];

  for (const element of nonVideoElements) {
    if (element.type === 'text') {
      lines.push(element.content);
    } else if (element.type === 'img' && element.file) {
      const filePath = path.join(resourceDir, element.file);
      const base64Data = await processMediaFile(filePath, 'image');
      if (base64Data) {
        lines.push(h('image', { src: base64Data }));
      }
    }
  }

  lines.push(session.text('commands.cave.message.contributorSuffix', [cave.contributor_name]));
  return lines.join('\n');
}
