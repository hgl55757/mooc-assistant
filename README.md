# MOOC 学习测验助手

当前版本：**1.0.1**。这是本地仓库，没有配置远程地址，也没有上传到网络。

## 文件

- `mooc-assistant.user.js`：当前维护的油猴脚本。
- `mooc-assistant.txt`：与脚本内容相同，方便全选复制。
- `archive/merged/`：融合版 1.0.0～1.0.3 快照。
- `archive/legacy/`：融合前的两个脚本及能找到的修改版本。
- `CHANGELOG.md`：版本变化和导入说明。
- `tests/`：模拟回归检查；不连接真实课程、不提交学习记录。

## 使用

把当前脚本或 TXT 的全部内容复制到油猴编辑器，保存后刷新课程页面。只启用一个版本。

自动学习处理视频和文档，跳过讨论与独立测验；视频弹题保留自动处理和继续学习。视频真正结束后等待完成标记，默认最多 30 秒，超时处理可在设置中选择。

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
