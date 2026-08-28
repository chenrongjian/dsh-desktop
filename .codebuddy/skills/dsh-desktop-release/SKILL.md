---
name: dsh-desktop-release
description: 发布 dsh-desktop(Tauri 桌面应用)新版本到 GitHub Releases 的完整流程。当用户要求"发布 dsh desktop 新版本"、"发版"、"打 tag 发布"、"release dsh-desktop"、"发布 vX.Y.Z"、"把新版本推到 GitHub Releases"、"发布安装包"时使用。涵盖版本号同步、打 tag 触发 CI、构建监控、Release 产物验证与失败排查。
---

# dsh-desktop 版本发布

> 本 skill 有两份副本:本仓库内 `.codebuddy/skills/dsh-desktop-release/`(随仓库同步,克隆即用)与用户级 `~/.codebuddy/skills/dsh-desktop-release/`(全局可用)。两者内容保持一致;改动任一份后请同步另一份。下面脚本路径以仓库内副本为准,在仓库根目录执行。

## 项目信息

- 仓库: https://github.com/chenrongjian/dsh-desktop (SSH: `git@github.com:chenrongjian/dsh-desktop.git`)
- 本地路径: `~/WorkBuddy/DeepSeek/desktop/dsh-desktop`
- 触发机制: 推送 `v*` 格式的 tag 自动触发 `.github/workflows/build.yml`;也可在 Actions 页面 workflow_dispatch 手动触发(输入 tag 名)
- CI 构建 4 个平台: macOS x86_64 / macOS aarch64 / Windows x86_64 / Linux x86_64,全部成功后 publish job 发布到 GitHub Releases
- 产物(7 个): macOS `.dmg` ×2、Windows `.exe` + `.msi`、Linux `.AppImage` + `.deb` + `.rpm`,均内置静态 ffmpeg,用户安装即用

## 版本号位置

- `package.json` 顶层 `"version"`
- `src-tauri/tauri.conf.json` 顶层 `"version"`

两处必须一致,且与 tag 对应(tag `vX.Y.Z` ↔ 版本 `X.Y.Z`)。发布版本以 tauri.conf.json 为准。

## 发布流程

### 方式一:使用发布脚本(推荐)

在仓库根目录执行:

```bash
# 常规:升版本号到 0.1.1 并发布(自动同步两处版本号、commit、push main、打 tag)
bash .codebuddy/skills/dsh-desktop-release/scripts/release.sh 0.1.1

# 版本号不变(已在两处配好),只打 tag 发布
bash .codebuddy/skills/dsh-desktop-release/scripts/release.sh 0.1.1 --no-bump

# 可指定项目路径(仓库外调用时)
DSH_DESKTOP_DIR=/path/to/dsh-desktop bash .codebuddy/skills/dsh-desktop-release/scripts/release.sh 0.1.1
```

脚本会自动:校验版本号格式 → 检查工作区无未提交改动 → 同步两处版本号 → commit + push main → 打 tag + push tag 触发 CI。

### 方式二:手动执行

```bash
cd ~/WorkBuddy/DeepSeek/desktop/dsh-desktop

# 1. 同步版本号(如发布 0.1.1):把 package.json 和 src-tauri/tauri.conf.json 的 "version" 都改为 "0.1.1"

# 2. 提交并推送
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to 0.1.1"
git push origin main

# 3. 打 tag 并推送(触发 CI)
git tag v0.1.1
git push origin v0.1.1

# 4. 如需删掉重来(仅当 tag 未发布过)
git tag -d v0.1.1 && git push origin :refs/tags/v0.1.1 && git tag v0.1.1 && git push origin v0.1.1
```

## 监控 CI 构建

推送 tag 后必须等待 4 个平台构建完成并确认 publish 成功。两种方式:

### 方式 A:gh CLI(若已登录)

```bash
cd ~/WorkBuddy/DeepSeek/desktop/dsh-desktop
gh run watch --exit-status    # 阻塞等待,结束时若失败会退出非零
gh run list --limit 5
```

### 方式 B:keychain token + curl(本机已验证可靠)

```bash
TOKEN=$(security find-internet-password -s github.com -w 2>/dev/null)
# 查看最近一次 run 的 5 个 job 状态
RUN_ID=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/chenrongjian/dsh-desktop/actions/runs?per_page=1" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['workflow_runs'][0]['id'])")
curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/chenrongjian/dsh-desktop/actions/runs/$RUN_ID/jobs" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for j in d['jobs']:
    cur = next((s['name'] for s in reversed(j['steps']) if s['status']=='in_progress'), '-')
    print(f\"{j['name']:<50} {j['status']:<11} {j['conclusion'] or '-':<9} now: {cur}\")
"
```

## 验证发布产物

全部 job 成功(publish 也 success)后,检查 Releases 上是否有 7 个安装包:

```bash
TOKEN=$(security find-internet-password -s github.com -w 2>/dev/null)
curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/chenrongjian/dsh-desktop/releases" \
  | python3 -c "
import json,sys
for r in json.load(sys.stdin):
    print(f\"Release: {r['tag_name']}  ({len(r['assets'])} assets)\")
    for a in sorted(r['assets'], key=lambda x: x['name']):
        print(f\"   {a['name']:<58} {a['size']/1024/1024:6.1f} MB\")
"
```

预期 7 个产物(名字示例,平台后缀按实际):
`鲸灵_<ver>_aarch64.dmg`、`..._x64.dmg`、`..._x64-setup.exe`、`..._x64_en-US.msi`、`.AppImage`、`.deb`、`.rpm`。若某平台产物缺失或 `0 assets`,按下方排查。

## 失败排查(本项目已知问题)

CI 中任一步骤失败时,先定位失败 job 与步骤(用上面监控命令看 `conclusion`),拉日志:

```bash
JOB_ID=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/chenrongjian/dsh-desktop/actions/runs/$RUN_ID/jobs" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print([j['id'] for j in d['jobs'] if 'windows' in j['name']][0])")
curl -sS -L -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/chenrongjian/dsh-desktop/actions/jobs/$JOB_ID/logs" -o /tmp/gh_win.txt
grep -n -i "error\[E\|error:\|cannot find\|failed to" /tmp/gh_win.txt | head -20
```

本项目踩过的坑(均已固化在 build.yml,若再次出现说明回归):

1. `libspa-sys` 找不到库 → Linux 需装 `libpipewire-0.3-dev libspa-0.2-dev libasound2-dev`,且 runner 必须是 `ubuntu-24.04`(22.04 的 libspa 太旧,scap 编译报 `spa_video_info_raw has no field named flags`)
2. Windows ffmpeg 解压:不要用 PowerShell `Expand-Archive` 访问 git bash 的 `/tmp`(MSYS 路径不可见);用 `/c/Windows/System32/tar.exe -xf` 解压 zip
3. Linux johnvansickle 下载 ffmpeg 需带 User-Agent(`curl -A`),否则返回非 xz 内容报 `File format not recognized`
4. Windows 上 `cp ffmpeg.exe ffmpeg`(无扩展名副本)会报 `same file`(MSYS 把两者视为同一文件);ffmpeg 资源应打包整个 `binaries/` 目录(`"resources": ["binaries"]`),运行时按 `binaries/ffmpeg` → `binaries/ffmpeg.exe` 查找
5. `windows-capture` 必须锁 `1.4.1`(scap 0.0.8 依赖 `^1.3.6`,1.5.0 改了 `Settings::new` 签名为 8 参数导致 E0061);用 `cargo update -p windows-capture --precise 1.4.1` 并提交 Cargo.lock
6. `fs::Permissions::from_mode` 仅 Unix 可用,必须用编译期 `#[cfg(unix)] {}` 块(运行时 `if cfg!(unix)` 在 Windows 仍会编译报错)
7. Release 产物 glob 必须递归:`bundles/**/*.dmg` 等(upload-artifact 保留目录层级,`bundles/*.dmg` 会 0 assets)
8. workflow 内不要再写 pnpm `version:`(与 package.json 的 packageManager 冲突导致 "The version field is redundant")

修复后重新发布:commit + push main → 重建 tag(`git tag -d` + 删远端 tag + 重打) → 重新触发 CI。重建 tag 会重新跑全部 4 平台,有 cargo cache 会快很多。

## 前置检查清单

发布前确认:

- [ ] 目标版本号已确定,`package.json` 与 `src-tauri/tauri.conf.json` 一致
- [ ] 工作区无未提交改动(发布脚本会自动检查)
- [ ] 不破坏 main 的构建(本地 `pnpm tauri build` 或信任 CI;CI 是权威)
- [ ] 变更涉及 Rust 代码时,注意 Windows 专用编译路径(scap/windows-capture、cfg(unix) 等)

## 重要提醒

- 发布是"打 tag"触发的,永远不要对已发布的 tag 强制覆盖推送(`--force`),会破坏 Release
- macOS 安装包未签名(无 Apple Developer 证书),用户首次打开需右键 → 打开
- CI 失败时先看日志再改,改完必须重建 tag 才能让新 workflow 生效
