# macOS 代码签名与录屏权限修复（Tauri 应用）

> 本文档记录 dsh-desktop（鲸灵）在 macOS 上"已授权但录屏失败"问题的完整排查与修复过程（2026-08-30 实战验证有效）。
> 适用于：Tauri/Electron 等桌面应用在 macOS 上使用 `scap` / ScreenCaptureKit 录屏时遇到权限问题。

## 症状

1. 应用内点击录制，顶部提示"未获得屏幕录制权限，请在弹窗或「系统设置 → 隐私与安全性 → 屏幕录制」中允许本应用后重试"。
2. 系统设置里「鲸灵」开关已打开（蓝色），但点击录制仍失败。
3. 应用每次重新部署后权限就失效，需要重新授权。

## 根本原因链

```
Tauri 打包未签名(或 ad-hoc 签名)
  → macOS TCC(隐私权限)不认可 ad-hoc 签名的应用,授权不持久生效
  → 尝试用 Apple Development 证书签名
  → 证书链断裂:codesign 报 "unable to build chain to self-signed root" + errSecInternalComponent
  → 根因:钥匙串里误删了旧版 Apple Root CA(CN=Apple Root CA)
```

关键事实：

- 免费 Apple Development 证书的链是：
  `Apple Development: you@example.com (XXXXXXXXXX)` → `Apple Worldwide Developer Relations CA G3` → **旧版 `Apple Root CA`**（注意是旧版根，不是 `Apple Root CA - G3`）。
- macOS 15+ 的系统信任存储已移除旧版 `Apple Root CA`，因此默认信任策略下链无法闭合。
- `security verify-cert` 能通过（它按 AKI/SKI 匹配验证），但 `codesign` 的链校验更严格，要求到受信任根。

## 排查命令

```bash
# 1. 检查当前签名状态(ad-hoc 时显示 Signature=adhoc,且无 Authority)
codesign -dv --verbose=2 /Applications/鲸灵.app 2>&1

# 2. 检查可用签名身份
security find-identity -v -p codesigning

# 3. 尝试签名(报 errSecInternalComponent)
codesign --force --deep --sign "Apple Development: you@example.com (XXXXXXXXXX)" /Applications/鲸灵.app

# 4. 检查证书链:比对 AKI/SKI 确认签发关系
security find-certificate -c "Apple Development: you@example.com" -p ~/Library/Keychains/login.keychain-db \
  | openssl x509 -noout -text | grep -A4 -E "Authority Key Identifier|Subject Key Identifier"
# 期望:Apple Development 的 AKI == WWDRCA G3 的 SKI;WWDRCA G3 的 AKI == 旧版 Apple Root CA 的 SKI

# 5. 检查系统根证书里是否还有旧版 Apple Root CA
security find-certificate -c "Apple Root CA" -Z /System/Library/Keychains/SystemRootCertificates.keychain 2>/dev/null | grep -E "SHA-1 hash|alis"
```

## 修复步骤（实战有效）

### 第 1 步：下载 WWDRCA G3 中间证书

Apple 官网证书直链必须带浏览器 User-Agent，否则返回 HTML 页面：

```bash
mkdir -p ~/jingling-certs
curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" \
  -o ~/jingling-certs/AppleWWDRCAG3.cer \
  https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
# 验证确为证书文件(而非 HTML)
file ~/jingling-certs/AppleWWDRCAG3.cer   # 期望: Certificate, Version=3
```

其他有用的 Apple 证书直链（均需带 UA）：

| 证书 | URL |
|------|-----|
| WWDRCA G3 中间证书 | `https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer` |
| Apple Root CA - G3 根 | `https://www.apple.com/certificateauthority/AppleRootCA-G3.cer` |
| 旧版 Apple Root CA（Apple Inc. Root） | `https://www.apple.com/appleca/AppleIncRootCertificate.cer` |

### 第 2 步：把 WWDRCA G3 设为系统信任根（跳过被废弃的旧版根）

这是本方案的核心。因为旧版 `Apple Root CA` 在 macOS 15+ 不再被信任，直接把 WWDRCA G3 作为信任锚（trustRoot），链就能闭合：

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/jingling-certs/AppleWWDRCAG3.cer
```

注意：这是**非标准的本机信任配置**，仅在这台 Mac 有效。重装系统/换机需重新导入；升级大版本 macOS 后建议复查。

### 第 3 步：重新签名

```bash
codesign --force --deep --sign "Apple Development: you@example.com (XXXXXXXXXX)" /Applications/鲸灵.app
```

### 第 4 步：验证签名

```bash
codesign -dv --verbose=2 /Applications/鲸灵.app 2>&1 | grep -E "Signature=|Authority="
```

成功标志：

```
Signature=Apple Development
Authority=Apple Development: you@example.com (XXXXXXXXXX)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
```

### 第 5 步：重置 TCC 授权（关键，容易漏）

签名身份从 ad-hoc 变为 Apple Development 后，TCC 把它当作"新应用"，旧授权不生效。必须：

1. 完全退出应用（Cmd + Q）。
2. 打开「系统设置 → 隐私与安全性 → 录屏与系统录音」。
3. 用列表底部的 `-` 号**删除**「鲸灵」条目（不是只关开关！必须删除）。
4. 重新启动应用，点击录制，系统弹出授权请求 → 点"打开系统设置"→ 打开开关。
5. 录制即正常。

> 实测教训：只"关闭再打开开关"不行，必须**删除条目后重新授权**。

## 陷阱清单

1. **不要随意删除钥匙串里的 Apple 根证书/中间证书**。本次事故的直接原因就是误删旧版 `Apple Root CA`。
2. **Apple 官网证书 URL 需要浏览器 UA**，否则返回 HTML（`file` 命令会显示 HTML document）。用 `curl -A "Mozilla/5.0 ..."`。
3. **ad-hoc 签名应用无法获得持久 TCC 权限**（录屏/麦克风等）。这是 macOS 安全设计，不是 bug。应用每次重新部署后权限都会失效。
4. **Xcode「Manage Certificates」删除按钮灰色**：证书存在钥匙串里时 Xcode 无法删除，需在「钥匙串访问.app → 登录 → 证书」里右键删除。
5. **`security verify-cert` 通过 ≠ `codesign` 能签名**：两者链校验严格度不同，以 codesign 为准。
6. **证书在登录/系统钥匙串出现多个重复副本**（本次出现 9 份）：一般不影响签名，但容易造成混淆，清理时注意只删副本、别删根证书。
7. 免费 Apple Development 证书仍由旧版根签发的 WWDRCA G3 签发，macOS 15+ 下 `add-trusted-cert -r trustRoot` 是唯一免付费的绕过手段；根治需付费 Apple Developer 账号。

## 常见误区

- ❌ 反复删除/重新生成 Apple Development 证书：生成出来的还是旧链，无用。
- ❌ 用 `security set-key-partition-list` 折腾私钥 ACL：本案例私钥访问没问题（Terminal 里无弹窗），是链的问题。
- ❌ 把中间证书导入登录钥匙串就期望 codesign 认：需要的是**系统信任锚**（`System.keychain` + `trustRoot`）。
