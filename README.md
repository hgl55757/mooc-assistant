# MOOC 学习测验助手

当前版本：**1.0.10**。项目仓库：[hgl55757/mooc-assistant](https://github.com/hgl55757/mooc-assistant)。本地与远程通过 Git 管理版本。

## 安装

**需要先安装油猴（Tampermonkey）浏览器扩展，脚本不能单独运行。**

1. 打开 [Tampermonkey 官网](https://www.tampermonkey.net/)，选择你使用的浏览器并安装扩展。
2. 点击下面的“一键安装”，在油猴弹出的脚本安装页确认安装；已有同名脚本时确认更新。
3. 打开或刷新 [中国大学 MOOC](https://www.icourse163.org/) 课程学习页面，右侧出现“MOOC 助手”面板即可使用。请只启用一个版本，避免重复操作。

[![一键安装油猴脚本](https://img.shields.io/badge/%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85-%E6%B2%B9%E7%8C%B4%E8%84%9A%E6%9C%AC-00b894?style=for-the-badge)](https://raw.githubusercontent.com/hgl55757/mooc-assistant/main/mooc-assistant.user.js)

[直接打开安装链接](https://raw.githubusercontent.com/hgl55757/mooc-assistant/main/mooc-assistant.user.js) · [查看脚本源码](mooc-assistant.user.js)

如果链接显示代码而没有弹出油猴安装页，请确认油猴已启用，并按扩展提示允许用户脚本运行。仍不能安装时，可打开 [TXT 文本](mooc-assistant.txt)，复制全部内容到油猴“添加新脚本”的编辑器，保存后刷新课程页面。

### 更新

一键安装的脚本已配置 GitHub 更新地址。油猴会按自身更新设置检查新版，也可以在油猴管理面板手动检查更新；不需要重新复制整段代码。通过旧 TXT 安装的版本，建议先用上方按钮更新安装一次，以获取更新地址。发布新版时会提高脚本版本号。

安装和更新均从 GitHub Raw 获取脚本；如果地址暂时无法访问，可稍后重试或使用 TXT 手动安装。

## 参考项目与许可证

本项目基于以下两个脚本融合修改，感谢原作者的工作：

1. **中国大学MOOC-自动化**，作者 **weiy02**：
   - [GitHub 项目：weiy02/ChinaMOOC-Auto](https://github.com/weiy02/ChinaMOOC-Auto)
   - [脚本发布页](https://scriptcat.org/zh-CN/script-show-page/8833)
   - 提供自动学习及课程导航等基础逻辑，原项目采用 MIT 许可证。
2. **中国大学MOOC 自动完成助手**，发布作者 **haoduoyv**，命名空间 `icourse-auto`：
   - [ScriptCat 原脚本发布页](https://scriptcat.org/en/script-show-page/6282)
   - 提供自选题模式、模型配置及选择/填空处理等基础逻辑，原脚本及发布页标注 MIT。未确认其独立 GitHub 源码仓库，以上链接为发布页。

本项目沿用 **MIT 许可证**，保留上游版权及许可声明；修改部分署名为 **Azureus**。完整许可见 [LICENSE](LICENSE)，第三方来源说明见 [THIRD_PARTY.md](THIRD_PARTY.md)。分发副本时请保留相关版权与许可声明。

## 文件

- `mooc-assistant.user.js`：当前维护的油猴脚本。
- `mooc-assistant.txt`：与脚本内容相同，方便全选复制。
- `CHANGELOG.md`：版本变化和导入说明。
- `tests/`：模拟回归检查；不连接真实课程、不提交学习记录。

## 使用

安装完成后，从“自动学习”或“测验”标签开始操作。

自动学习从视频当前位置继续播放，处理视频和文档，跳过讨论与独立测验；视频弹题保留自动处理和继续学习。视频真正结束后直接进入下一项，不等待平台完成标记；平台已经跳转时接着处理当前项，避免重复跳转。导航先处理当前小节内的内容，再进入右侧下一小节；只有本章小节全部结束，才切换左侧章节并从新章第一节开始，例如 `6.2 → 6.3 → 7.1 → 7.2`。目录读取或切换未确认时会暂停，避免漏节。

测验采用自选题模式，只做单选、多选、判断和填空。LLM 的 API Key 请在浏览器配置界面自行填写；仓库不保存实际密钥、浏览器配置或登录信息。
