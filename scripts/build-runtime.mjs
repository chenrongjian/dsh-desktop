/**
 * 构建内置 dsh 运行时（打包进 .app，用户安装即用，无需本机安装 Node/dsh）。
 *
 * 流程：
 *   1. 从 deepseek-harness 源码复制精简副本（排除 .git/node_modules/dist/lib/截图等）
 *   2. 复制构建产物 vendor/dsh-runtime-assets（web dist / cli lib / packages/vendor 的 lib、native）
 *   3. 移除根 postinstall（lefthook，与运行无关）
 *   4. pnpm install --frozen-lockfile（生成 node_modules 与 workspace 链接）
 *   5. 裁剪纯构建/测试工具类 devDeps（trim-dev-deps.mjs）
 *   6. 下载内置 Node 二进制到 node/
 *   7. 写 runtime.json（版本信息），并用内置 node 验证 dsh 可运行
 *
 * 跨平台：全部使用 Node API 与跨平台命令，可在 macOS / Windows / Linux 上运行。
 * 构建产物（lib/dist）由 vendor/dsh-runtime-assets 提供，无需在构建机上现场编译
 * deepseek-harness（其 master 的 tsc 全量构建因测试文件类型错误不可用）。
 *
 * 幂等：目标目录已存在且 runtime.json 版本匹配时跳过（加速重复构建）。
 */
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const HERE = resolve(import.meta.dirname);
const ROOT = resolve(HERE, "..");
const TARGET =
  process.env.DSH_RUNTIME_TARGET ?? join(ROOT, "src-tauri/binaries/dsh-runtime");
const ASSETS = join(ROOT, "vendor/dsh-runtime-assets");

const NODE_VERSION = "v24.19.0";
const PROJECT_DIR =
  process.env.DSH_PROJECT_DIR ??
  resolve(process.env.HOME ?? ".", "WorkBuddy/DeepSeek/deepseek-harness");
const isWin = process.platform === "win32";

// 源码复制时排除的目录（产物目录 dist/lib 由 vendor/dsh-runtime-assets 提供）
const EXCLUDE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "lib",
  "coverage",
  "generated-images",
  "covers",
  "website",
]);
const EXCLUDE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif"]);

function suffix() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "win32") return "win-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

function srcFilter(src) {
  if (EXCLUDE_DIRS.has(basename(src))) return false;
  if (EXCLUDE_EXT.has(extname(src).toLowerCase())) return false;
  return true;
}

function sh(cmd, opts = {}) {
  console.log(`+ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
}

async function run() {
  console.log(`[build-runtime] target=${TARGET}`);
  console.log(`[build-runtime] project=${PROJECT_DIR}`);
  console.log(`[build-runtime] assets=${ASSETS}`);

  // 场景开关：跳过 runtime 构建（保留兼容）
  if (process.env.DSH_SKIP_RUNTIME === "1") {
    console.log("[build-runtime] DSH_SKIP_RUNTIME=1，跳过 runtime 构建");
    return;
  }

  if (!existsSync(join(PROJECT_DIR, "pnpm-workspace.yaml"))) {
    console.error(`DSH_PROJECT_DIR 不是有效的 deepseek-harness 项目: ${PROJECT_DIR}`);
    process.exit(1);
  }
  if (!existsSync(ASSETS)) {
    console.error(`构建产物目录缺失: ${ASSETS}（请先运行 scripts/collect-runtime-assets.sh 或检查提交）`);
    process.exit(1);
  }

  // 幂等：已有完整产物则跳过
  const runtimeJson = join(TARGET, "runtime.json");
  if (existsSync(runtimeJson)) {
    try {
      const prev = JSON.parse(readFileSync(runtimeJson, "utf8"));
      if (prev.node === NODE_VERSION && prev.source === PROJECT_DIR) {
        console.log("[build-runtime] 已存在，跳过（如需重建请删除 src-tauri/binaries/dsh-runtime）");
        return;
      }
    } catch { /* fallthrough */ }
  }

  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });

  // 1) 复制源码（排除产物目录与截图）
  console.log("[build-runtime] 1/7 复制源码…");
  cpSync(PROJECT_DIR, TARGET, { recursive: true, filter: srcFilter });

  // 2) 复制构建产物
  console.log("[build-runtime] 2/7 复制构建产物…");
  copyAsset(join(ASSETS, "web-dist"), join(TARGET, "apps/web/dist"));
  copyAsset(join(ASSETS, "cli-lib"), join(TARGET, "apps/cli/lib"));
  copyAsset(join(ASSETS, "packages"), join(TARGET, "packages"));
  copyAsset(join(ASSETS, "vendor"), join(TARGET, "vendor"));
  copyAsset(join(ASSETS, "native"), join(TARGET, "native"));

  // 3) 移除根 postinstall（lefthook git hooks，与运行时无关）
  console.log("[build-runtime] 3/7 移除 postinstall…");
  const rootPkg = join(TARGET, "package.json");
  const pkg = JSON.parse(readFileSync(rootPkg, "utf8"));
  delete pkg.scripts?.postinstall;
  writeFileSync(rootPkg, JSON.stringify(pkg, null, 2) + "\n");

  // 4) 安装完整依赖
  console.log("[build-runtime] 4/7 pnpm install（完整依赖，约 1-6 分钟）…");
  // corepack 按 deepseek-harness 的 packageManager(pnpm@11.7.0) 切换，保证 lockfile 兼容
  try { sh("corepack enable", { cwd: TARGET }); } catch { /* corepack 不可用时沿用当前 pnpm */ }
  sh("pnpm install --frozen-lockfile", { cwd: TARGET, env: { ...process.env, CI: "true" } });
  await new Promise((r) => setTimeout(r, 2000));

  // 5) 裁剪 devDeps
  console.log("[build-runtime] 5/7 裁剪 devDeps…");
  sh(`node "${join(HERE, "trim-dev-deps.mjs")}" "${TARGET}"`);

  // 6) 下载内置 Node
  console.log(`[build-runtime] 6/7 下载 Node ${NODE_VERSION} (${suffix()})…`);
  const ext = isWin ? "zip" : "tar.gz";
  const nodeUrl = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${suffix()}.${ext}`;
  const resp = await fetch(nodeUrl);
  if (!resp.ok) throw new Error(`下载 Node 失败: HTTP ${resp.status} ${nodeUrl}`);
  const archive = join(TARGET, `node-archive.${ext}`);
  writeFileSync(archive, Buffer.from(await resp.arrayBuffer()));
  const nodeDir = join(TARGET, "node");
  mkdirSync(nodeDir, { recursive: true });
  // tar 自动识别格式：GNU tar 与 bsdtar 均支持；Windows 自带 bsdtar 可解 zip
  sh(`tar -xf "${archive}" -C "${nodeDir}" --strip-components=1`);
  rmSync(archive, { force: true });

  // 7) 验证 + 写 runtime.json
  console.log("[build-runtime] 7/7 验证内置 dsh…");
  const nodeBin = join(TARGET, isWin ? "node/node.exe" : "node/bin/node");
  const verOut = sh(`"${nodeBin}" "${join(TARGET, "apps/cli/lib/bin.js")}" --version`, { stdio: "pipe" })
    .toString()
    .trim();
  console.log(`[build-runtime] 内置 dsh 版本: ${verOut}`);
  writeFileSync(
    runtimeJson,
    JSON.stringify({ node: NODE_VERSION, dsh: verOut, source: PROJECT_DIR, builtAt: new Date().toISOString() }, null, 2),
  );
  console.log(`[build-runtime] 完成，体积: ${(du(TARGET) / 1e9).toFixed(2)} GB`);
}

function copyAsset(src, dest) {
  if (!existsSync(src)) {
    console.warn(`[build-runtime] 警告: 产物目录不存在，跳过: ${src}`);
    return;
  }
  mkdirSync(resolve(dest, ".."), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function du(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += du(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
