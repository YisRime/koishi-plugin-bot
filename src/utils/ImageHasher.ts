import sharp from 'sharp';
import { Buffer } from 'buffer';

/**
 * 图片哈希计算工具类
 * 使用 DCT(离散余弦变换)方法计算图片的感知哈希值，可用于图片相似度比较
 */
export class ImageHasher {
  /**
   * 计算图片的感知哈希值
   * @param imageBuffer - 图片的二进制数据
   * @returns 返回64位的十六进制哈希字符串
   * @throws 当图片处理失败时可能抛出错误
   */
  static async calculateHash(imageBuffer: Buffer): Promise<string> {
    try {
      const { data } = await sharp(imageBuffer)
        .grayscale()
        .resize(32, 32, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const dctMatrix = ImageHasher.computeDCT(data, 32);
      const features = ImageHasher.extractFeatures(dctMatrix, 32);
      const median = ImageHasher.calculateMedian(features);
      const binaryHash = features.map(val => val > median ? '1' : '0').join('');
      return ImageHasher.binaryToHex(binaryHash);
    } catch (error) {
      throw new Error(`Failed to calculate image hash: ${error.message}`);
    }
  }

  /**
   * 将二进制字符串转换为十六进制
   * @param binary - 二进制字符串
   * @returns 十六进制字符串
   * @private
   */
  private static binaryToHex(binary: string): string {
    const hex = [];
    // 每4位二进制转换为1位16进制
    for (let i = 0; i < binary.length; i += 4) {
      const chunk = binary.slice(i, i + 4);
      hex.push(parseInt(chunk, 2).toString(16));
    }
    return hex.join('');
  }

  /**
   * 将十六进制字符串转换为二进制
   * @param hex - 十六进制字符串
   * @returns 二进制字符串
   * @private
   */
  private static hexToBinary(hex: string): string {
    let binary = '';
    for (const char of hex) {
      // 将每个16进制字符转为4位二进制
      const bin = parseInt(char, 16).toString(2).padStart(4, '0');
      binary += bin;
    }
    return binary;
  }

  /**
   * 计算图像的DCT(离散余弦变换)
   * @param data - 图像数据
   * @param size - 图像尺寸
   * @returns DCT变换后的矩阵
   * @private
   */
  private static computeDCT(data: Uint8Array, size: number): number[][] {
    const matrix: number[][] = Array(size).fill(0).map(() => Array(size).fill(0));
    const output: number[][] = Array(size).fill(0).map(() => Array(size).fill(0));

    // 将1D数组转为2D矩阵
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        matrix[i][j] = data[i * size + j];
      }
    }

    // 计算2D DCT
    for (let u = 0; u < size; u++) {
      for (let v = 0; v < size; v++) {
        let sum = 0;
        for (let x = 0; x < size; x++) {
          for (let y = 0; y < size; y++) {
            const cx = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size));
            const cy = Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
            sum += matrix[x][y] * cx * cy;
          }
        }
        output[u][v] = sum * this.getDCTCoefficient(u, size) * this.getDCTCoefficient(v, size);
      }
    }

    return output;
  }

  /**
   * 获取DCT系数
   * @param index - 索引值
   * @param size - 矩阵大小
   * @returns DCT系数
   * @private
   */
  private static getDCTCoefficient(index: number, size: number): number {
    return index === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
  }

  /**
   * 计算数组的中位数
   * @param arr - 输入数组
   * @returns 中位数
   * @private
   */
  private static calculateMedian(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * 从DCT矩阵中提取特征值
   * @param matrix - DCT矩阵
   * @param size - 矩阵大小
   * @returns 特征值数组
   * @private
   */
  private static extractFeatures(matrix: number[][], size: number): number[] {
    const features: number[] = [];
    const featureSize = 8;

    for (let i = 0; i < featureSize; i++) {
      for (let j = 0; j < featureSize; j++) {
        features.push(matrix[i][j]);
      }
    }

    return features;
  }

  /**
   * 计算两个哈希值之间的汉明距离
   * @param hash1 - 第一个哈希值
   * @param hash2 - 第二个哈希值
   * @returns 汉明距离
   * @throws 当两个哈希值长度不等时抛出错误
   */
  static calculateDistance(hash1: string, hash2: string): number {

    if (hash1.length !== hash2.length) {
      throw new Error('Hash lengths must be equal');
    }

    const bin1 = ImageHasher.hexToBinary(hash1);
    const bin2 = ImageHasher.hexToBinary(hash2);

    let distance = 0;
    for (let i = 0; i < bin1.length; i++) {
      if (bin1[i] !== bin2[i]) distance++;
    }
    return distance;
  }

  /**
   * 计算两个图片哈希值的相似度
   * @param hash1 - 第一个哈希值
   * @param hash2 - 第二个哈希值
   * @returns 返回0-1之间的相似度值，1表示完全相同，0表示完全不同
   */
  static calculateSimilarity(hash1: string, hash2: string): number {
    const distance = ImageHasher.calculateDistance(hash1, hash2);
    return (64 - distance) / 64;
  }

  /**
   * 批量比较一个新哈希值与多个已存在哈希值的相似度
   * @param newHash - 新的哈希值
   * @param existingHashes - 已存在的哈希值数组
   * @returns 相似度数组，每个元素对应一个已存在哈希值的相似度
   */
  static batchCompareSimilarity(
    newHash: string,
    existingHashes: string[]
  ): number[] {
    return existingHashes.map(hash => ImageHasher.calculateSimilarity(newHash, hash));
  }
}
