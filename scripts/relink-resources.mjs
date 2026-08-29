/**
 * Tauri bundler 复制 resources 时不保留符号链接，而 pnpm node_modules 依赖符号链接解析。
 * 本脚本在打包后的 .app 里，按照源目录（src-tauri/binaries）重建所有符号链接。
 *
 * 用法：node scripts/relink-resources.mjs /path/to/鲸灵.app
 */
import { readdirSync, symlinkSync, existsSync, lstatSync, readlinkSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const APP = process.argv[2];
if (!APP) {
  console.error("usage: node scripts/relink-resources.mjs /path/to/鲸灵.app");
  process.exit(1);
}

const SOURCE = resolve(import.meta.dirname, "../src-tauri/binaries");
const TARGET = join(APP, "Contents/Resources/binaries");

let created = 0;
let failed = 0;

function walk(src, dst) {
  let entries;
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isSymbolicLink()) {
      const target = readlinkSyncSafe(s);
      if (target == null) continue;
      if (existsSync(d) || lstatExists(d)) continue; // 已有文件/链接则跳过
      try {
        symlinkSync(target, d);
        created++;
      } catch {
        failed++;
      }
    } else if (e.isDirectory()) {
      if (!existsSync(d) && !lstatExists(d)) {
        try {
          mkdirSync(d, { recursive: true });
        } catch { /* ignore */ }
      }
      walk(s, d);
    }
  }
}

function readlinkSyncSafe(p) {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

function lstatExists(p) {
  try {
    return lstatSync(p) !== undefined;
  } catch {
    return false;
  }
}

if (!existsSync(TARGET)) {
  console.error(`no resources at ${TARGET}`);
  process.exit(1);
}

walk(SOURCE, TARGET);
console.log(`relink: created ${created} symlinks, failed ${failed}`);
