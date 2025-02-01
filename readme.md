# koishi-plugin-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bot)

## 简介

这是一个为 Koishi 机器人开发的趣味性插件，目前提供回声洞功能，让用户可以轻松收藏和分享有趣的文字与图片内容。

## 功能特性

### 回声洞系统 (cave)

一个支持文字和图片的内容收藏系统。
0.0.20首个可用版本，0.0.34完善发送保存功能。

#### 主要特点

- 支持文字与图片混合保存
- 支持转义字符的正确显示
- 智能处理QQ图片链接
- 群组调用冷却机制
- 权限管理系统

#### 使用方法

支持以下指令：

- `cave` - 随机展示一条回声洞
- `cave -a <内容>` - 添加新回声洞（支持文字/图片）
- `cave -g <编号>` - 查看指定编号的回声洞
- `cave -r <编号>` - 删除指定编号的回声洞（需要权限）

#### 配置项
