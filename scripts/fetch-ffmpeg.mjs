// 获取静态 ffmpeg 到 src-tauri/binaries/
// 已存在则跳过（发布用静态版，开发可用系统/brew 版）
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src-tauri', 'binaries');
const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const target = path.join(dir, exe);

if (existsSync(target) && statSync(target).size > 1_000_000) {
  console.log(`[ffmpeg] 已存在: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
const urls = {
  darwin: 'https://evermeet.cx/ffmpeg/getrelease/zip',
  win32: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  linux: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
};
const url = urls[process.platform];
if (!url) {
  console.log('[ffmpeg] 未识别的平台,跳过下载');
  process.exit(0);
}

console.log(`[ffmpeg] 下载静态 ffmpeg (${process.platform})...`);
try {
  const tmp = path.join('/tmp', `ff-static-${process.platform}`);
  execSync(`curl -sL --retry 2 --max-time 300 -o ${tmp} "${url}"`, { stdio: 'inherit' });
  if (process.platform === 'darwin') {
    execSync(`unzip -o ${tmp} -d ${dir}`, { stdio: 'inherit' });
  } else if (process.platform === 'win32') {
    execSync(`powershell -Command "Expand-Archive -Force ${tmp} -DestinationPath ${dir}"`, { stdio: 'inherit' });
    // find ffmpeg.exe inside the extracted folder
    const found = execSync(`powershell -Command "(Get-ChildItem -Recurse ${dir} -Filter ffmpeg.exe | Select-Object -First 1).FullName"`).toString().trim();
    if (found) execSync(`copy /Y "${found}" "${target}"`);
  } else {
    execSync(`mkdir -p ${dir}/ffx && tar xJf ${tmp} -C ${dir}/ffx`, { stdio: 'inherit' });
    const found = execSync(`find ${dir}/ffx -name ffmpeg -type f | head -1`).toString().trim();
    if (found) execSync(`cp "${found}" "${target}"`);
  }
  execSync(`chmod +x ${target}`, { stdio: 'inherit' });
  console.log(`[ffmpeg] 就绪: ${target}`);
} catch (e) {
  console.error(`[ffmpeg] 下载失败: ${e.message}`);
  console.error('[ffmpeg] 请手动放置静态 ffmpeg 到 src-tauri/binaries/,或使用系统安装的 ffmpeg');
  process.exit(0); // 不阻塞构建,recorder 运行时会回退到系统 PATH
}
