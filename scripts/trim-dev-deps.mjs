/**
 * 裁剪内置 dsh 运行时中纯构建/测试工具类 devDependencies，缩小体积。
 *
 * 安全性原则：只删除「不在任何包（含自身）的 dependencies/optionalDependencies/
 * peerDependencies 中出现过」的 devDependency 包。这类包不会被运行时 import。
 * 例如 vitest / oxlint / typescript / tsdown / eslint 等。
 */
import { readdirSync, existsSync, rmSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const NM = join(ROOT, "node_modules");
const PNPM = join(NM, ".pnpm");

/** 收集所有 package.json 的依赖声明 */
function collectDeps() {
  const runtime = new Set(); // 任何包声明为运行时依赖的包名
  const devOnly = new Set(); // 被声明为 devDependency 的包名

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "coverage") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "package.json") {
        try {
          const j = JSON.parse(readFileSync(p, "utf8"));
          for (const d of [j.dependencies, j.optionalDependencies, j.peerDependencies] ?? []) {
            if (d) for (const k of Object.keys(d)) runtime.add(k);
          }
          if (j.devDependencies) for (const k of Object.keys(j.devDependencies)) devOnly.add(k);
        } catch { /* ignore */ }
      }
    }
  }
  walk(ROOT);
  return { runtime, devOnly };
}

function main() {
  if (!existsSync(PNPM)) {
    console.log("no .pnpm store, skip");
    return;
  }
  const { runtime, devOnly } = collectDeps();
  const toRemove = [...devOnly].filter((n) => !runtime.has(n));
  console.log(`candidates: ${toRemove.length}`);

  let removed = 0;
  for (const name of toRemove) {
    const scope = name.startsWith("@") ? name.split("/")[0] : null;
    const short = name.startsWith("@") ? name.split("/")[1] : name;
    const prefix = scope ? `${scope.slice(1)}+${short}@` : `${short}@`;
    // 删除 .pnpm 虚拟存储里的所有版本
    if (existsSync(PNPM)) {
      for (const d of readdirSync(PNPM)) {
        if (d.startsWith(prefix)) {
          rmSync(join(PNPM, d), { recursive: true, force: true });
          removed++;
        }
      }
    }
    // 删除顶层/嵌套的符号链接（死链无害，但清理干净）
    const linkTargets = [
      join(NM, name),
      join(NM, ".pnpm", "node_modules", name),
    ];
    for (const t of linkTargets) {
      if (existsSync(t)) rmSync(t, { recursive: true, force: true });
    }
  }
  console.log(`removed ${removed} package dirs`);

  // 清理所有指向已删除目标的死符号链接（Tauri resources 打包要求路径全部存在）。
  // 起点必须是整个运行时根目录：workspace 源码包的 node_modules 里也有 pnpm 链接。
  let dead = 0;
  (function prune(dir, depth) {
    if (depth > 24) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(p);
        } catch {
          continue;
        }
        const abs = resolve(dir, target);
        if (!existsSync(abs)) {
          try {
            rmSync(p);
            dead++;
          } catch { /* ignore */ }
        }
      } else if (e.isDirectory()) {
        prune(p, depth + 1);
      }
    }
  })(ROOT, 0);
  console.log(`pruned ${dead} dead links`);
}

main();
