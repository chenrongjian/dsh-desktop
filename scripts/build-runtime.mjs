/**
 * 构建内置 dsh 运行时（打包进 .app，用户安装即用，无需本机安装 Node/dsh）。
 *
 * 流程：
 *   1. 从本地 deepseek-harness 源码复制精简副本（排除 .git/node_modules/截图等）
 *   2. 复制前端构建产物 apps/web/dist
 *   3. 移除根 postinstall（lefthook，与运行无关）
 *   4. pnpm install --frozen-lockfile（完整依赖；dsh 部分运行时依赖声明在 devDeps）
 *   5. 裁剪纯构建/测试工具类 devDeps（trim-dev-deps.mjs）
 *   6. 下载内置 Node 二进制到 node/
 *   7. 写 runtime.json（版本信息），并用内置 node 验证 dsh 可运行
 *
 * 幂等：目标目录已存在且 runtime.json 版本匹配时跳过（加速重复构建）。
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = resolve(import.meta.dirname);
const ROOT = resolve(HERE, "..");
const TARGET = join(ROOT, "src-tauri/binaries/dsh-runtime");

const NODE_VERSION = "v24.19.0";
const PROJECT_DIR =
  process.env.DSH_PROJECT_DIR ?? resolve(process.env.HOME ?? ".", "WorkBuddy/DeepSeek/deepseek-harness");

function suffix() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "win32") return "win-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

function sh(cmd, opts = {}) {
  console.log(`+ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
}

async function run() {  console.log(`[build-runtime] target=${TARGET}`);
  console.log(`[build-runtime] project=${PROJECT_DIR}`);

  if (!existsSync(join(PROJECT_DIR, "pnpm-workspace.yaml"))) {
    console.error(`DSH_PROJECT_DIR 不是有效的 deepseek-harness 项目: ${PROJECT_DIR}`);
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

  // 1) 复制源码
  console.log("[build-runtime] 1/7 复制源码…");
  sh(
    `rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude 'coverage' ` +
      `--exclude '*.png' --exclude '*.jpg' --exclude '*.jpeg' --exclude '*.gif' ` +
      `--exclude 'generated-images' --exclude 'covers' --exclude 'website' ` +
      `"${PROJECT_DIR}/" "${TARGET}/"`,
  );

  // 2) 前端构建产物（web-app 通过 @deepseek-ai/dsh-web-frontend/dist/index.html 查找）
  console.log("[build-runtime] 2/7 复制前端 dist…");
  const webDist = join(PROJECT_DIR, "apps/web/dist");
  if (existsSync(webDist)) {
    sh(`mkdir -p "${TARGET}/apps/web" && cp -R "${webDist}" "${TARGET}/apps/web/dist"`);
  } else {
    console.warn("[build-runtime] 警告: 未找到 apps/web/dist，请先在 deepseek-harness 中执行 pnpm run build");
  }

  // 3) 移除根 postinstall（lefthook git hooks，与运行时无关）
  console.log("[build-runtime] 3/7 移除 postinstall…");
  sh(
    `node -e "const fs=require('fs');const p='${join(TARGET, "package.json").replaceAll("'", "\\'")}';` +
      `const j=JSON.parse(fs.readFileSync(p,'utf8'));delete j.scripts.postinstall;fs.writeFileSync(p,JSON.stringify(j,null,2))"`,
  );

  // 4) 安装完整依赖
  console.log("[build-runtime] 4/7 pnpm install（约 1-2 分钟）…");
  sh(`cd "${TARGET}" && CI=true pnpm install --frozen-lockfile`);
  await new Promise((r) => setTimeout(r, 2000));

  // 5) 裁剪 devDeps
  console.log("[build-runtime] 5/7 裁剪 devDeps…");
  sh(`node "${join(HERE, "trim-dev-deps.mjs")}" "${TARGET}"`);

  // 6) 下载内置 Node
  console.log(`[build-runtime] 6/7 下载 Node ${NODE_VERSION} (${suffix()})…`);
  const nodeUrl = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${suffix()}.tar.gz`;
  const archive = join(TARGET, "node-archive.tar.gz");
  sh(`curl -fsSL "${nodeUrl}" -o "${archive}"`);
  sh(`mkdir -p "${TARGET}/node" && tar -xzf "${archive}" -C "${TARGET}/node" --strip-components=1`);
  rmSync(archive, { force: true });

  // 7) 验证 + 写 runtime.json
  console.log("[build-runtime] 7/7 验证内置 dsh…");
  const nodeBin = join(TARGET, "node/bin/node");
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

function du(dir) {
  const out = execSync(`du -sk "${dir}"`, { stdio: "pipe" }).toString().trim().split("\t")[0];
  return Number(out) * 1024;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
