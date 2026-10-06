#!/usr/bin/env node
// W1-5 基准脚本：生成 10 万文件临时目录，供扫描/增量/缩略图性能测量。
// 纯 Node（无依赖），跨平台（Windows / macOS / Linux）。
//
// 用法：
//   node scripts/bench/gen-files.mjs                 # 默认 10 万空文件（最快、占用最小）
//   node scripts/bench/gen-files.mjs --count 2000 --size-mode small
//   node scripts/bench/gen-files.mjs --dups 300 --large 5
//   node scripts/bench/gen-files.mjs --clean         # 仅删除 --out 目录
//
// 设计要点（对齐扫描器行为）：
//   - 扩展名取自 Rust VIDEO_EXTS，确保被 scanner 纳入。
//   - 每个文件随机 mtime（过去 400 天内），用于测量增量 diff（path/mtime/size）。
//   - --dups 注入与既有文件「同名同大小同内容」的副本，用于验证重复识别。
//   - --large 生成 >500MB 文件，用于命中缩略图「>500MB 带进度」路径。

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
  existsSync,
  openSync,
  ftruncateSync,
  closeSync,
} from "node:fs";
import { resolve, join } from "node:path";

const VIDEO_EXTS = [
  "mp4",
  "mkv",
  "avi",
  "mov",
  "wmv",
  "flv",
  "webm",
  "m4v",
  "mpg",
  "mpeg",
  "3gp",
  "ogv",
  "rm",
  "vob",
  "m2ts",
];

const DAY = 24 * 60 * 60;
const NOW = Math.floor(Date.now() / 1000);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const out = {
    out: "tmp/bench-100k",
    count: 100000,
    depth: 3,
    branch: 4,
    sizeMode: "empty", // empty | small | mixed | fixed
    fixedSize: 0,
    dups: 0,
    large: 0,
    largeSize: 512 * 1024 * 1024 + 1, // >500MB
    seed: 20261004,
    clean: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--out":
        out.out = next();
        break;
      case "--count":
        out.count = parseInt(next(), 10);
        break;
      case "--depth":
        out.depth = parseInt(next(), 10);
        break;
      case "--branch":
        out.branch = parseInt(next(), 10);
        break;
      case "--size-mode":
        out.sizeMode = next();
        break;
      case "--fixed-size":
        out.fixedSize = parseInt(next(), 10);
        break;
      case "--dups":
        out.dups = parseInt(next(), 10);
        break;
      case "--large":
        out.large = parseInt(next(), 10);
        break;
      case "--large-size":
        out.largeSize = parseInt(next(), 10);
        break;
      case "--seed":
        out.seed = parseInt(next(), 10);
        break;
      case "--clean":
        out.clean = true;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        break;
    }
  }
  return out;
}

function printHelp() {
  console.log("生成 10 万文件临时目录（影栈扫描性能基准）。详见文件头注释。");
}

function pickSize(rng, mode, fixed) {
  switch (mode) {
    case "empty":
      return 0;
    case "fixed":
      return fixed;
    case "small":
      return Math.floor(rng() * 1024 * 1024); // 0–1MiB
    case "mixed": {
      // 90% 小文件，10% 1–16MiB，模拟真实分布
      if (rng() < 0.9) return Math.floor(rng() * 1024 * 1024);
      return 1024 * 1024 + Math.floor(rng() * 15 * 1024 * 1024);
    }
    default:
      return 0;
  }
}

function buildTree(root, depth, branch, rng) {
  const dirs = [root];
  let cur = [root];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const p of cur) {
      for (let b = 0; b < branch; b++) {
        const name = `dir_${d}_${b}_${Math.floor(rng() * 1e6).toString(36)}`;
        const child = join(p, name);
        mkdirSync(child, { recursive: true });
        dirs.push(child);
        next.push(child);
      }
    }
    cur = next;
  }
  return dirs;
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const root = resolve(process.cwd(), opt.out);

  if (opt.clean) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
      console.log(`已删除 ${root}`);
    } else {
      console.log(`不存在，无需删除 ${root}`);
    }
    return;
  }

  mkdirSync(root, { recursive: true });
  const rng = mulberry32(opt.seed);

  console.log(`生成基准目录：${root}`);
  console.log(
    `参数：count=${opt.count} depth=${opt.depth} branch=${opt.branch} size=${opt.sizeMode} dups=${opt.dups} large=${opt.large}`,
  );

  const dirs = buildTree(root, opt.depth, opt.branch, rng);
  console.log(`目录数：${dirs.length}`);

  const total = opt.count + opt.dups + opt.large;
  console.log(
    `目标文件数：${total}（视频 ${opt.count} + 副本 ${opt.dups} + 大文件 ${opt.large}）`,
  );

  let bytes = 0;
  const t0 = Date.now();
  let lastLog = t0;
  const recorded = []; // {dir, name, size, buf} 用于注入副本

  const writeOne = (dir, name, size, buf) => {
    const full = join(dir, name);
    if (buf && buf.length) writeFileSync(full, buf);
    else writeFileSync(full, Buffer.alloc(0));
    // 随机 mtime：过去 0–400 天
    const mtime = NOW - Math.floor(rng() * 400 * DAY);
    try {
      utimesSync(full, mtime, mtime);
    } catch {
      /* 某些文件系统不支持，忽略 */
    }
    bytes += size;
  };

  let created = 0;
  for (let i = 0; i < opt.count; i++) {
    const dir = dirs[Math.floor(rng() * dirs.length)];
    const ext = VIDEO_EXTS[Math.floor(rng() * VIDEO_EXTS.length)];
    const name = `movie_${String(i).padStart(7, "0")}.${ext}`;
    const size = pickSize(rng, opt.sizeMode, opt.fixedSize);
    let buf = null;
    if (size > 0) buf = randomBytes(size);
    writeOne(dir, name, size, buf);
    recorded.push({ dir, name, size, buf });
    created++;
    if (opt.verbose || Date.now() - lastLog > 1000) {
      const el = (Date.now() - t0) / 1000;
      const rate = created / Math.max(el, 1e-3);
      const eta = (total - created) / Math.max(rate, 1e-3);
      process.stderr.write(
        `\r  ${created}/${total}  ${rate.toFixed(0)}/s  ETA ${eta.toFixed(0)}s  已写 ${fmtBytes(bytes)}`,
      );
      lastLog = Date.now();
    }
  }

  // 注入副本：复用既有文件的 同名/同大小/同内容，放入不同目录
  for (let i = 0; i < opt.dups; i++) {
    const src = recorded[Math.floor(rng() * recorded.length)];
    let targetDir = dirs[Math.floor(rng() * dirs.length)];
    // 尽量放进不同目录，确保跨目录重复
    let guard = 0;
    while (targetDir === src.dir && guard++ < 8) {
      targetDir = dirs[Math.floor(rng() * dirs.length)];
    }
    writeOne(targetDir, src.name, src.size, src.buf);
    created++;
  }

  // 大文件：>500MB，命中缩略图进度路径
  for (let i = 0; i < opt.large; i++) {
    const dir = dirs[Math.floor(rng() * dirs.length)];
    const name = `large_${String(i).padStart(4, "0")}.mkv`;
    const size = Math.max(opt.largeSize, 512 * 1024 * 1024 + 1);
    const buf = randomBytes(size > 64 * 1024 * 1024 ? 0 : size);
    // 过大时只写稀疏头尾，避免真实占满磁盘；size 元信息仍 >500MB
    if (buf.length === 0) {
      const full = join(dir, name);
      writeFileSync(full, Buffer.alloc(0));
      // 用 truncate 设置逻辑大小（不实际落盘全部内容）
      const fd = openSync(full, "r+");
      ftruncateSync(fd, size);
      closeSync(fd);
      const mtime = NOW - Math.floor(rng() * 400 * DAY);
      try {
        utimesSync(full, mtime, mtime);
      } catch {
        // 某些文件系统不支持改时间戳，继续生成
      }
      bytes += size;
    } else {
      writeOne(dir, name, size, buf);
    }
    created++;
  }

  const el = (Date.now() - t0) / 1000;
  console.log("");
  console.log(
    `完成：共 ${created} 文件，总大小 ${fmtBytes(bytes)}，耗时 ${el.toFixed(1)}s`,
  );
  console.log(`在影栈中选择目录：${root} 即可扫描`);
}

try {
  main();
} catch (e) {
  console.error("生成失败：", e);
  process.exit(1);
}
