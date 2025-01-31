# koishi-plugin-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bot)

## 简介

这是一个Koishi机器人插件，提供多种实用功能。

## 功能列表

### 1. 回声洞(cave)系统

回声洞系统可以存储和管理有趣的文字或图片内容。
版本 0.0.20 为首个可用版本。

#### 指令用法

cave [-a/-g/-r] [内容]

#### 支持的操作

- 添加回声洞：`cave -a [文字/图片]`
- 查看回声洞：`cave -g <序号>`
- 随机查看：`cave`
- 删除回声洞：`cave -r <序号>`

#### 使用示例

- `cave` - 随机查看一条回声洞
- `cave -a 内容` - 添加一条回声洞
- `cave -g 1` - 查看序号为1的回声洞
- `cave -r 1` - 删除序号为1的回声洞
