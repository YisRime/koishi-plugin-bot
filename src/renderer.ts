import { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import fs from 'fs'
import path from 'path'
import { formatTime } from './formatter'

/**
 * 渲染玩家信息到图片
 * @param html HTML内容
 * @param ctx Koishi上下文
 * @returns 图片Buffer
 */
export async function renderToImage(html: string, ctx: Context): Promise<Buffer> {
  // 确保临时目录存在
  const tempDir = path.join(ctx.baseDir, 'temp')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  // 使用puppeteer渲染HTML为图片
  try {
    // 创建一个新页面
    const page = await ctx.puppeteer.page()

    // 设置完整的HTML内容，包括CSS样式
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: 'Arial', sans-serif;
              background-color: #f0f2f5;
              color: #333;
              padding: 0;
              margin: 0;
            }
            .container {
              width: 800px;
              margin: 0 auto;
              background-color: #fff;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
              padding: 20px;
              overflow: hidden;
            }
            .header {
              text-align: center;
              padding-bottom: 10px;
              border-bottom: 1px solid #eee;
              margin-bottom: 15px;
            }
            .header h1 {
              margin: 0;
              color: #4a76a8;
              font-size: 24px;
            }
            .section {
              margin-bottom: 20px;
              padding-bottom: 10px;
              border-bottom: 1px solid #eee;
            }
            .section-title {
              font-weight: bold;
              color: #4a76a8;
              margin-bottom: 10px;
              font-size: 18px;
            }
            .stat-item {
              margin-bottom: 8px;
              line-height: 1.5;
            }
            .map-list {
              font-size: 13px;
              color: #666;
              margin-left: 15px;
              margin-top: 3px;
            }
            .small {
              font-size: 13px;
            }
            .highlight {
              font-weight: bold;
              color: #3b5998;
            }
            .recent-finishes {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
              gap: 8px;
            }
            .finish-card {
              background: #f9f9f9;
              border-radius: 6px;
              padding: 8px;
              border-left: 3px solid #4a76a8;
            }
            .finish-time {
              color: #e63946;
              font-weight: bold;
            }
            .finish-date {
              color: #666;
              font-size: 12px;
            }
            .partners-grid {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
              gap: 8px;
            }
            .partner-card {
              background: #f9f9f9;
              border-radius: 6px;
              padding: 8px;
              display: flex;
              align-items: center;
            }
            .partner-count {
              margin-left: auto;
              background: #4a76a8;
              color: white;
              border-radius: 12px;
              padding: 2px 8px;
              font-size: 12px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            ${html}
          </div>
        </body>
      </html>
    `, { waitUntil: 'networkidle0' })

    // 等待内容完全加载
    await page.waitForSelector('.container')

    // 获取容器元素的大小
    const rect = await page.evaluate(() => {
      const container = document.querySelector('.container');
      const rect = container.getBoundingClientRect();
      // 返回容器的大小数据
      return {
        width: rect.width,
        height: rect.height,
        paddingTop: parseInt(getComputedStyle(container).paddingTop),
        paddingBottom: parseInt(getComputedStyle(container).paddingBottom),
        paddingLeft: parseInt(getComputedStyle(container).paddingLeft),
        paddingRight: parseInt(getComputedStyle(container).paddingRight)
      };
    });

    // 设置视口大小，确保完整显示内容
    await page.setViewport({
      width: Math.ceil(rect.width) + 20, // 小边距
      height: Math.ceil(rect.height) + 20, // 小边距
      deviceScaleFactor: 2.0 // 提高图片清晰度
    });

    // 截图
    const imageBuffer = await page.screenshot({
      type: 'png',
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(rect.width) + 20,
        height: Math.ceil(rect.height) + 20
      },
      omitBackground: false
    });

    // 关闭页面以释放资源
    await page.close();

    return imageBuffer;
  } catch (error) {
    ctx.logger.error('图片渲染失败:', error);
    throw new Error('图片渲染失败: ' + error.message);
  }
}

/**
 * 将玩家信息转换为HTML
 * @param data DDNet API 返回的玩家数据
 * @returns HTML字符串
 */
export function formatPlayerInfoToHtml(data: any): string {
  const playerName = data.player
  let html = `
    <div class="header">
      <h1>🏆 ${playerName} 的 DDNet 信息</h1>
    </div>
  `;

  // 合并显示排名和分数信息
  html += `
    <div class="section">
      <div class="section-title">📊 排名与分数</div>
  `;

  // 总分信息
  if (data.points && typeof data.points === 'object') {
    const total = data.points.total || 0;
    const rank = data.points.rank || '未排名';
    const points = data.points.points || 0;
    html += `<div class="stat-item">• 总分: <span class="highlight">${points}/${total}</span> (全球第 ${rank} 名)</div>`;
  }

  // 个人与团队排名合并显示
  if (data.rank && typeof data.rank === 'object') {
    html += `<div class="stat-item">• 个人排名: 第 <span class="highlight">${data.rank.rank || '?'}</span> 名 (${data.rank.points || 0} 分)</div>`;
  }

  if (data.team_rank && typeof data.team_rank === 'object') {
    html += `<div class="stat-item">• 团队排名: 第 <span class="highlight">${data.team_rank.rank || '?'}</span> 名 (${data.team_rank.points || 0} 分)</div>`;
  }

  html += `</div>`;

  // 最近时间段成绩合并显示
  if (data.points_last_year || data.points_last_month || data.points_last_week) {
    html += `
      <div class="section">
        <div class="section-title">📅 最近活跃度</div>
    `;

    if (data.points_last_year && data.points_last_year.points) {
      html += `<div class="stat-item">• 过去一年: <span class="highlight">${data.points_last_year.points}</span> 分 (第 ${data.points_last_year.rank || '?'} 名)</div>`;
    }

    if (data.points_last_month && data.points_last_month.points) {
      html += `<div class="stat-item">• 过去一月: <span class="highlight">${data.points_last_month.points}</span> 分 (第 ${data.points_last_month.rank || '?'} 名)</div>`;
    }

    if (data.points_last_week && data.points_last_week.rank) {
      html += `<div class="stat-item">• 过去一周: <span class="highlight">${data.points_last_week.points || 0}</span> 分 (第 ${data.points_last_week.rank} 名)</div>`;
    } else {
      html += `<div class="stat-item">• 过去一周: 暂无排名</div>`;
    }

    html += `</div>`;
  }

  // 首次完成和常用服务器
  html += `
    <div class="section">
      <div class="section-title">🎮 游戏信息</div>
  `;

  if (data.favorite_server) {
    const server = typeof data.favorite_server === 'object' ?
                  (data.favorite_server.server || JSON.stringify(data.favorite_server)) :
                  data.favorite_server;
    html += `<div class="stat-item">• 常用服务器: <span class="highlight">${server}</span></div>`;
  }

  if (data.hours_played_past_365_days !== undefined) {
    html += `<div class="stat-item">• 年度游戏时间: <span class="highlight">${data.hours_played_past_365_days}</span> 小时</div>`;
  }

  if (data.first_finish) {
    const date = new Date(data.first_finish.timestamp * 1000);
    const formattedDate = `${date.getFullYear()}年${(date.getMonth()+1)}月${date.getDate()}日`;
    const map = data.first_finish.map;
    const timeString = formatTime(data.first_finish.time);

    html += `<div class="stat-item">• 首次完成: ${formattedDate} - <span class="highlight">${map}</span> (${timeString})</div>`;
  }

  html += `</div>`;

  // 地图完成详细统计 - 显示所有地图类型的详细信息
  if (data.types && typeof data.types === 'object') {
    html += `
      <div class="section">
        <div class="section-title">🗺️ 地图类型统计</div>
    `;

    const typesEntries = Object.entries(data.types);

    if (typesEntries.length > 0) {
      typesEntries.forEach(([typeName, typeInfo]: [string, any]) => {
        if (typeInfo) {
          // 获取类型的点数和排名信息
          let typePoints = 0;
          let typeRank = '未排名';
          let mapCount = 0;

          if (typeInfo.points) {
            if (typeof typeInfo.points === 'object') {
              typePoints = typeInfo.points.points || typeInfo.points.total || 0;
            } else {
              typePoints = typeInfo.points;
            }
          }

          if (typeInfo.rank && typeInfo.rank.rank) {
            typeRank = `第 ${typeInfo.rank.rank} 名`;
          }

          // 地图数量和列表
          if (typeInfo.maps) {
            mapCount = Object.keys(typeInfo.maps).length;
            html += `<div class="stat-item">• ${typeName}: <span class="highlight">${typePoints}</span> 分 (${typeRank}), 完成 <span class="highlight">${mapCount}</span> 张地图</div>`;

            // 如果有地图就列出一些地图名称(不超过10个,防止太长)
            if (mapCount > 0) {
              const mapNames: string[] = Object.keys(typeInfo.maps).slice(0, 10);
              html += `<div class="map-list">包括: ${mapNames.join(', ')}${mapCount > 10 ? ' 等...' : ''}</div>`;
            }
          }
        }
      });
    }

    html += `</div>`;
  }

  // 最近完成的地图
  if (data.last_finishes && Array.isArray(data.last_finishes) && data.last_finishes.length > 0) {
    html += `
      <div class="section">
        <div class="section-title">🏁 最近完成记录 (${data.last_finishes.length}项)</div>
        <div class="recent-finishes">
    `;

    // 最多显示8个最近记录
    const recentFinishes = data.last_finishes.slice(0, 8);

    recentFinishes.forEach((finish: any) => {
      if (finish.timestamp && finish.map) {
        const date = new Date(finish.timestamp * 1000);
        const formattedDate = `${date.getFullYear()}/${(date.getMonth()+1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
        const timeString = formatTime(finish.time);

        html += `
          <div class="finish-card">
            <div>${finish.map} (${finish.type || '未知'}) <span class="finish-time">${timeString}</span></div>
            <div class="finish-date">${formattedDate} - ${finish.country || '未知'} 服务器</div>
          </div>
        `;
      }
    });

    html += `</div></div>`;
  }

  // 最常合作的伙伴
  if (data.favorite_partners && Array.isArray(data.favorite_partners) && data.favorite_partners.length > 0) {
    html += `
      <div class="section">
        <div class="section-title">👥 常用队友 (${data.favorite_partners.length}位)</div>
        <div class="partners-grid">
    `;

    // 最多显示8个队友
    const partners = data.favorite_partners.slice(0, 8);

    partners.forEach((partner: any) => {
      if (partner.name && partner.finishes) {
        html += `
          <div class="partner-card">
            ${partner.name} <span class="partner-count">${partner.finishes}次</span>
          </div>
        `;
      }
    });

    html += `</div></div>`;
  }

  // 活跃度信息 - 如果有就显示统计数据
  if (data.activity && Array.isArray(data.activity) && data.activity.length > 0) {
    // 计算统计数据
    let totalHours = 0;
    let maxHours = 0;
    let activeDays = 0;
    let activeMonths = new Set();

    data.activity.forEach((day: any) => {
      if (day && day.hours_played) {
        totalHours += day.hours_played;
        maxHours = Math.max(maxHours, day.hours_played);

        if (day.hours_played > 0) {
          activeDays++;
          if (day.date) {
            // 提取年月 (YYYY-MM)
            const month = day.date.substring(0, 7);
            activeMonths.add(month);
          }
        }
      }
    });

    const avgHoursPerActiveDay = activeDays > 0 ? (totalHours / activeDays).toFixed(1) : "0";

    html += `
      <div class="section">
        <div class="section-title">📊 活跃度统计</div>
        <div class="stat-item">• 活跃天数: <span class="highlight">${activeDays}</span> 天</div>
        <div class="stat-item">• 活跃月数: <span class="highlight">${activeMonths.size}</span> 个月</div>
        <div class="stat-item">• 单日最长游戏: <span class="highlight">${maxHours}</span> 小时</div>
        <div class="stat-item">• 平均每日游戏: <span class="highlight">${avgHoursPerActiveDay}</span> 小时</div>
      </div>
    `;
  }

  return html;
}
