# MOOC 学习测验助手

当前版本：**1.0.9**。项目仓库：[hgl55757/mooc-assistant](https://github.com/hgl55757/mooc-assistant)。本地与远程通过 Git 管理版本。

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
- `archive/merged/`：融合版 1.0.0～1.0.4 快照。
- `archive/legacy/`：融合前的两个脚本及能找到的修改版本。
- `CHANGELOG.md`：版本变化和导入说明。
- `tests/`：模拟回归检查；不连接真实课程、不提交学习记录。

## 使用

安装完成后，从“自动学习”或“测验”标签开始操作。

自动学习从视频当前位置继续播放，处理视频和文档，跳过讨论与独立测验；视频弹题保留自动处理和继续学习。视频真正结束后直接进入下一项，不等待平台完成标记；平台已经跳转时接着处理当前项，避免重复跳转。

测验采用自选题模式，只做单选、多选、判断和填空。LLM 的 API Key 请在浏览器配置界面自行填写；仓库不保存实际密钥、浏览器配置或登录信息。

## Git 常用操作

在该文件夹打开终端，或先执行（中文路径加引号）：

```powershell
cd "C:\Users\ASUS\Desktop\MOOC脚本\MOOC学习测验融合版"
git status
git log --oneline --decorate
git diff
```

修改脚本后同步 TXT、运行检查，再提交：

```powershell
Copy-Item -LiteralPath .\mooc-assistant.user.js -Destination .\mooc-assistant.txt -Force
Get-Content -Raw -Encoding UTF8 .\tests\run-tests.js | node
git add mooc-assistant.user.js mooc-assistant.txt CHANGELOG.md
git commit -m "说明这次修改"
```

查看旧版本而不覆盖当前文件：

```powershell
git show v1.0.1:mooc-assistant.user.js
```

从旧版本创建一个独立分支继续修改：

```powershell
git switch -c inspect-v1.0.1 v1.0.1
```

回到最新版：`git switch main`。切换前请先提交或妥善保存当前修改。

## 历史说明

本仓库是在已有文件基础上补建。Git 提交时间为导入时间，不代表原始开发时间。
1.0.0、1.0.1、1.0.3 来自保留文件；1.0.2 按已知的 1.0.3 点击修复差异逆向恢复，并在归档说明中标注。旧版本仅供对照，可能包含已经修复的问题。

来源与许可证见 `THIRD_PARTY.md` 和 `LICENSE`。

## 运行中断排查

学习计划和运行记录按标签页独立保存，不再读取旧版共享计划。更新后需手动启动一次；同一标签页刷新可以续跑，关闭标签页后不保留计划。日志页的“查看运行记录”保留当前标签页最近 40 条启动、恢复、停止、导航失败和异常记录，刷新后仍可查看。停止按钮会区分真实点击与程序触发。切到后台只记录，不主动停止。页面刷新会尝试续跑；浏览器关闭、进程崩溃或计时器冻结时，脚本无法保证继续运行，未记录的中断也不能事后断定来源。

切换检测只比较课程路径、学期和视频单元编号；标题、完成文字、无关网址参数或 hash 变化不会触发切课取消。同课程内自动或手动切换课件后，会接着处理当前页面，避免重复跳转；跨课程或学期仍停止旧任务。切换记录包含前后编号。平台先更新路由、后替换播放器时会等待新播放器就绪，超时明确暂停。平台已跳转时不把跳转当作上一视频完成标记已确认。

标签导航按当前目录重新定位目标，使用原生点击并最多重试一次，避免重绘后检查旧节点误报超时。视频标签加载失败时暂停保留当前项；弹题隐藏 video 画面时继续识别媒体元素。运行记录包含版本、内容类型、目标标签和切换失败时的当前标签。
