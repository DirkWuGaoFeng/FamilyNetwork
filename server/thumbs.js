/**
 * 缩略图与视频封面：按需生成 webp，永久缓存
 *
 * 3700 多个素材、30GB 原图，根本不可能直接丢给浏览器。这里的原则是：
 * 谁被看到才处理谁，处理过的永久复用（缓存键带原图修改时间，原图被替换会自动失效）。
 *
 * 照片用 sharp 缩放；视频得先用 ffmpeg 抽一帧，再走同一条流水线。
 * 没装 ffmpeg 时视频退回一张暖色占位图，不影响其余功能。
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const config = require('./config');

const THUMB_DIR = path.join(config.cacheDir, 'thumbs');
const ANIM_DIR = path.join(config.cacheDir, 'anim');
const DURATION_FILE = path.join(config.cacheDir, 'durations.json');

/** 可选依赖：装不上就只是没有真实视频封面，不能把整个服务带坑 */
function optional(name, field) {
  try {
    const mod = require(name);
    return field ? mod[field] : mod;
  } catch {
    return null;
  }
}

const FFMPEG = config.ffmpegPath || optional('ffmpeg-static') || 'ffmpeg';
const FFPROBE = config.ffprobePath || optional('ffprobe-static', 'path') || 'ffprobe';

/** 生成失败的图（损坏、格式怪异），记住一次就不再反复尝试 */
const broken = new Set();

let running = 0;
const waiters = [];

/**
 * 简单并发闸：一次最多 N 张图在编码，避免机械硬盘被随机读写拖死
 * @param {Function} task
 * @returns {Promise<*>}
 */
function schedule(task) {
  return new Promise((resolve, reject) => {
    waiters.push({ task, resolve, reject });
    drain();
  });
}

function drain() {
  while (running < config.thumbConcurrency && waiters.length > 0) {
    const { task, resolve, reject } = waiters.shift();
    running += 1;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        running -= 1;
        drain();
      });
  }
}

/**
 * 缩略图缓存路径（含宽与原图修改时间，原图变了就自动换名重生成）
 * @param {string} relPath 相对素材根目录的路径
 * @param {number} mtimeMs
 * @param {number} width
 * @returns {string}
 */
function cacheKey(relPath, mtimeMs, width) {
  const hash = crypto.createHash('sha1').update(`${relPath}|${mtimeMs}|${width}`).digest('hex');
  return path.join(THUMB_DIR, `${width}-${hash}.webp`);
}

/**
 * 视频封面：没有 ffmpeg 抽不了帧，用一张统一的暖色占位图，标注「视频」
 * @param {number} width
 * @returns {string} SVG 源码
 */
function videoPoster(width) {
  const height = Math.round(width * 0.66);
  const r = Math.max(14, Math.round(width * 0.055));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b2320"/><stop offset="1" stop-color="#4a3a33"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <circle cx="${width / 2}" cy="${height / 2}" r="${r}" fill="none" stroke="#f3e9dd" stroke-opacity=".85" stroke-width="1.5"/>
  <path d="M${width / 2 - r * 0.28} ${height / 2 - r * 0.42} L${width / 2 + r * 0.5} ${height / 2} L${width / 2 - r * 0.28} ${height / 2 + r * 0.42} Z" fill="#f3e9dd" fill-opacity=".92"/>
</svg>`;
}

/**
 * 取得某个素材的缩略图
 * @param {object} item 索引条目
 * @param {number} [width] 目标宽度
 * @returns {Promise<{file: string, type: string}|{svg: string, type: string}|null>} null 表示只能回退到原图
 */
async function getThumb(item, width = config.thumbWidth) {
  if (!item) {
    return null;
  }
  const abs = path.resolve(config.mediaRoot, item.path);
  const target = cacheKey(item.path, item.mtimeMs || 0, width);
  if (fs.existsSync(target)) {
    return { file: target, type: 'image/webp' };
  }
  if (item.kind === 'video') {
    if (!hasFfmpeg() || broken.has(`${item.path}|${width}`)) {
      return { svg: videoPoster(width), type: 'image/svg+xml' };
    }
    return schedule(() => videoThumb(item, abs, target, width));
  }
  if (broken.has(`${item.path}|${width}`)) {
    return null;
  }

  return schedule(async () => {
    if (fs.existsSync(target)) {
      return { file: target, type: 'image/webp' };
    }
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      // rotate() 依据 EXIF 方向自动摆正——手机拍的照片不转就会是躺着的
      await sharp(abs, { failOn: 'none' })
        .rotate()
        .resize({ width, height: width * 2, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: config.thumbQuality, effort: 4 })
        .toFile(tmp);
      await fsp.rename(tmp, target);
      return { file: target, type: 'image/webp' };
    } catch (err) {
      broken.add(`${item.path}|${width}`);
      await fsp.rm(tmp, { force: true }).catch(() => {});
      console.warn(`[thumb] 生成失败（${item.path}）: ${err.message}`);
      return null;
    }
  });
}

/** 这台机器上 ffmpeg 到底能不能用（只试一次，不能用就不再反复试） */
let ffmpegState = null;

async function detectFfmpeg() {
  if (ffmpegState !== null) {
    return ffmpegState;
  }
  try {
    await run(FFMPEG, ['-version'], 8000);
    ffmpegState = true;
    console.log(`[thumb] 视频抽帧可用：${FFMPEG}`);
  } catch (err) {
    ffmpegState = false;
    console.warn(`[thumb] 用不了 ffmpeg（${err.message}），视频将继续用占位封面`);
  }
  return ffmpegState;
}

function hasFfmpeg() {
  return ffmpegState === true;
}

/**
 * 跑一个子进程，超时、报错都变成 reject，绝不把控制台弹出来
 * @param {string} bin
 * @param {Array<string>} args
 * @param {number} timeoutMs
 * @returns {Promise<string>} stdout
 */
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(bin, args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`超时 ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      // 只留最后一截，ffmpeg 一个文件能刷几千行
      stderr = (stderr + chunk).slice(-1200);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`退出码 ${code}：${stderr.split('\n').filter(Boolean).pop() || '无输出'}`));
      }
    });
  });
}

/** 时长缓存：ffprobe 一次几十毫秒，但 628 个视频也没必要每次问 */
let durations = null;
let saveTimer = null;

function loadDurations() {
  if (durations) {
    return durations;
  }
  try {
    durations = JSON.parse(fs.readFileSync(DURATION_FILE, 'utf8'));
  } catch {
    durations = {};
  }
  return durations;
}

function rememberDuration(relPath, seconds) {
  loadDurations()[relPath] = seconds;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp.mkdir(config.cacheDir, { recursive: true })
      .then(() => fsp.writeFile(DURATION_FILE, JSON.stringify(durations)))
      .catch(() => {});
  }, 1500);
}

/**
 * 视频时长（秒），取不到返回 null
 * @param {object} item 索引条目
 * @param {string} abs 绝对路径
 * @returns {Promise<number|null>}
 */
async function probeDuration(item, abs) {
  const known = loadDurations()[item.path];
  if (known !== undefined) {
    return known || null;
  }
  try {
    const out = await run(FFPROBE, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', '-hide_banner', abs
    ], config.ffmpegTimeoutMs);
    const seconds = Number(out.trim());
    const value = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
    rememberDuration(item.path, value);
    return value || null;
  } catch (err) {
    rememberDuration(item.path, 0);
    return null;
  }
}

/**
 * 抽一帧并缩成 webp
 * @param {object} item
 * @param {string} abs
 * @param {string} target 缓存文件路径
 * @param {number} width
 * @returns {Promise<{file: string, type: string}|{svg: string, type: string}]}
 */
async function videoThumb(item, abs, target, width) {
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  const duration = await probeDuration(item, abs);
  const tmp = `${target}.${process.pid}.jpg`;
  // 开头往往是黑帧或台标，取开头 15% 但不超过 6 秒；短视频再往前提
  const offsets = duration
    ? [Math.min(duration * 0.15, 6), 0.4]
    : [1.5, 0.2];
  for (const at of offsets) {
    try {
      await run(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-ss', String(at), '-i', abs,
        '-frames:v', '1', '-q:v', '3', '-an', '-sn', tmp
      ], config.ffmpegTimeoutMs);
      const stat = await fsp.stat(tmp).catch(() => null);
      if (!stat || stat.size < 1024) {
        continue;
      }
      await sharp(tmp, { failOn: 'none' })
        .rotate()
        .resize({ width, height: width * 2, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: config.thumbQuality, effort: 4 })
        .toFile(`${target}.tmp`);
      await fsp.rename(`${target}.tmp`, target);
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return { file: target, type: 'image/webp' };
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      console.warn(`[thumb] 视频抽帧失败（${item.path} @${at}s）: ${err.message}`);
    }
  }
  broken.add(`${item.path}|${width}`);
  return { svg: videoPoster(width), type: 'image/svg+xml' };
}

/**
 * 把视频开头几秒做成一张循环动图（animated webp）
 *
 * 为什么不用 gif：同画质下 webp 通常只有 gif 的三分之一到一半，而且 ffmpeg 直接能写。
 * 浏览器自己循环，不需要 JS 定时器，也不占带宽第二次。
 *
 * @param {object} item 索引条目
 * @param {number} [width] 动图宽度
 * @returns {Promise<{file: string, type: string}>}
 */
async function makeAnim(item, width = 560) {
  const abs = path.resolve(config.mediaRoot, item.path);
  const key = crypto.createHash('sha1').update(`${item.path}|${item.mtimeMs || 0}|anim|${width}`).digest('hex');
  const target = path.join(ANIM_DIR, `${key}.webp`);
  if (fs.existsSync(target)) {
    return { file: target, type: 'image/webp' };
  }
  if (!hasFfmpeg()) {
    throw new Error('这台机器上没有可用的 ffmpeg，做不了动图');
  }
  if (broken.has(`anim|${item.path}`)) {
    throw new Error('这段视频抽不出帧，做不了动图');
  }

  return schedule(async () => {
    await fsp.mkdir(ANIM_DIR, { recursive: true });
    // 中间文件也必须以 .webp 结尾：ffmpeg 靠扩展名选封装格式，叫 .tmp 会直接「Invalid argument」
    const tmp = `${target}.${process.pid}.part.webp`;
    try {
      const duration = await probeDuration(item, abs);
      // 取开头 12%（不超过 3s）的一小段，短视频再缩短，2～3 秒足够看清发生了什么
      const start = duration ? Math.min(duration * 0.12, 3) : 0.5;
      const span = Math.min(2.4, Math.max(0.8, (duration || 3) * 0.25));
      await run(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-ss', String(start), '-t', String(span), '-i', abs,
        '-vf', `fps=9,scale=${width}:-2:flags=lanczos`,
        '-c:v', 'libwebp_anim', '-loop', '0', '-quality', '55', '-compression_level', '4',
        '-an', '-sn', tmp
      ], config.animTimeoutMs);
      const stat = await fsp.stat(tmp).catch(() => null);
      if (!stat || stat.size < 2048) {
        throw new Error('生成的动图为空或过小');
      }
      await fsp.rename(tmp, target);
      return { file: target, type: 'image/webp' };
    } catch (err) {
      broken.add(`anim|${item.path}`);
      await fsp.rm(tmp, { force: true }).catch(() => {});
      console.warn(`[anim] 制作失败（${item.path}）: ${err.message}`);
      throw err;
    }
  });
}

/**
 * 视频基本信息（前端卡片上的时长角标用），顺便提前把封面抽出来
 * @param {object} item 索引条目
 * @returns {Promise<{duration: number|null}>}
 */
async function videoInfo(item) {
  const abs = path.resolve(config.mediaRoot, item.path);
  const duration = hasFfmpeg() ? await probeDuration(item, abs) : null;
  // 不等它：列表页一打开就并行把封面准备好
  getThumb(item, config.previewWidth).catch(() => {});
  return { duration };
}

module.exports = { getThumb, videoPoster, videoInfo, makeAnim, detectFfmpeg, hasFfmpeg, THUMB_DIR };
