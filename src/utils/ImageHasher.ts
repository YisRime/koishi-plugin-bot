import sharp from 'sharp';
import { Buffer } from 'buffer';

/**
 * 图片哈希计算类
 */
export class ImageHasher {
  /**
   * 计算图片的小波哈希值
   */
  static async calculateHash(imageBuffer: Buffer): Promise<string> {
      // 转换为32x32灰度图以获得更好的特征
      const { data } = await sharp(imageBuffer)
        .grayscale()
        .resize(32, 32, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      // 应用Haar小波变换
      const waveletMatrix = this.haarWaveletTransform(data, 32);

      // 取左上角8x8区域作为特征区域
      const features = this.extractFeatures(waveletMatrix, 32);

      // 计算特征区域平均值
      const mean = features.reduce((sum, val) => sum + val, 0) / features.length;

      // 生成hash
      return features.map(val => val > mean ? '1' : '0').join('');
  }

  /**
   * Haar小波变换
   */
  private static haarWaveletTransform(data: Uint8Array, size: number): number[][] {
    const matrix: number[][] = Array(size).fill(0).map(() => Array(size).fill(0));

    // 将1D数组转为2D矩阵
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        matrix[i][j] = data[i * size + j];
      }
    }

    // 对行进行变换
    for (let i = 0; i < size; i++) {
      this.haarTransform1D(matrix[i]);
    }

    // 对列进行变换
    for (let j = 0; j < size; j++) {
      const col = matrix.map(row => row[j]);
      this.haarTransform1D(col);
      for (let i = 0; i < size; i++) {
        matrix[i][j] = col[i];
      }
    }

    return matrix;
  }

  /**
   * 1D Haar变换
   */
  private static haarTransform1D(arr: number[]): void {
    const len = arr.length;
    const temp = new Array(len).fill(0);

    for (let i = 0; i < len; i += 2) {
      if (i + 1 < len) {
        temp[i/2] = (arr[i] + arr[i+1]) / 2;
        temp[len/2 + i/2] = (arr[i] - arr[i+1]) / 2;
      } else {
        temp[i/2] = arr[i];
      }
    }

    for (let i = 0; i < len; i++) {
      arr[i] = temp[i];
    }
  }

  /**
   * 提取特征区域
   */
  private static extractFeatures(matrix: number[][], size: number): number[] {
    const features: number[] = [];
    const featureSize = 8; // 提取8x8特征

    for (let i = 0; i < featureSize; i++) {
      for (let j = 0; j < featureSize; j++) {
        features.push(matrix[i][j]);
      }
    }

    return features;
  }

  /**
   * 计算两个hash值的汉明距离
   * @param hash1 第一个hash值
   * @param hash2 第二个hash值
   * @returns 汉明距离(不同位的数量)
   */
  static calculateDistance(hash1: string, hash2: string): number {
    if (hash1.length !== hash2.length) {
      throw new Error('Hash lengths must be equal');
    }

    // 计算不同位的数量
    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] !== hash2[i]) distance++;
    }
    return distance;
  }

  /**
   * 计算两个图片的相似度
   * @param hash1 第一个图片hash
   * @param hash2 第二个图片hash
   * @returns 相似度百分比(0-10)
   */
  static calculateSimilarity(hash1: string, hash2: string): number {
    const distance = this.calculateDistance(hash1, hash2);
    // 将汉明距离转换为0-10的相似度值
    // 64位hash的最大汉明距离是64,所以用(64-distance)/64*10来计算相似度
    return (64 - distance) / 64 * 10;
  }

  /**
   * 批量比较一个新图片与多个已有hash的相似度
   * @param newHash 新图片hash
   * @param existingHashes 已有图片hash数组
   * @returns 相似度数组
   */
  static batchCompareSimilarity(
    newHash: string,
    existingHashes: string[]
  ): number[] {
    return existingHashes.map(hash => this.calculateSimilarity(newHash, hash));
  }
}
