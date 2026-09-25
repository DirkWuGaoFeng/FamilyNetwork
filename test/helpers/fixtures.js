/**
 * 测试用的假素材库
 *
 * 真库里三千多个文件、三十几个 GB，测试绝不能用它——慢，而且任何一次手动刷新
 * 都会让断言飘掉。这里在系统临时目录里造一棵小树，文件名刻意覆盖几种坑：
 * 微信导出的毫秒时间戳、快手那种长得像日期的哈希、隐藏目录、缩略图缓存目录。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

/** 一张纯色 PNG：够小，又能被 sharp 正常读出来 */
async function png(size = 8) {
  const sharp = require('sharp');
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 200, g: 160, b: 120 } }
  }).png().toBuffer();
}

/**
 * 造一棵素材目录树
 * @param {object} [options]
 * @param {boolean} [options.ignoreDirs] 是否包含「该被排除」的目录
 * @returns {Promise<{root: string, file: Function, cleanup: Function}>}
 */
async function buildMediaRoot(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-test-'));
  const image = await png();

  /**
   * 写一个文件并（可选）设定修改时间
   * @param {string} rel 相对素材根目录的路径（/ 分隔）
   * @param {Buffer} buf 内容
   * @param {string} [mtimeIso] 修改时间，ISO 字符串
   */
  async function put(rel, buf, mtimeIso) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
    if (mtimeIso) {
      const at = new Date(mtimeIso);
      await fsp.utimes(abs, at, at);
    }
    return abs;
  }

  const zero = Buffer.alloc(0);

  // --- 该被收录的 ---
  await put('婚礼/2019-10-06 仪式.png', image, '2019-10-06T12:00:00Z');
  await put('婚礼/摆拍/mmexport1602316522535.png', image, '2020-10-10T12:00:00Z');
  // 快手式哈希文件名：开头 13 位不是时间戳，必须退回修改时间而不是算出 1995 年
  await put('婚礼/0812400607203bd81893772.png', image, '2018-03-04T05:06:07Z');
  await put('婚礼/video.mp4', zero, '2021-05-20T08:00:00Z');
  await put('日常/IMG_20200101_201430.png', image, '2020-01-01T12:00:00Z');
  await put('日常/午饭.png', image, '2022-07-01T12:00:00Z');
  await put('IMG_rootless.png', image, '2023-02-02T12:00:00Z');
  // 后缀是 .png 但内容不是图：缩略图必须能体面地失败
  await put('日常/坏图.png', Buffer.from('这坨字节不是图片'), '2024-01-02T12:00:00Z');
  // 看着有日期、其实月份非法：该退回修改时间（2017-01-01）
  await put('日常/2019-13-45 假日期.png', image, '2017-01-01T12:00:00Z');

  // --- 不该出现的 ---
  if (options.ignoreDirs !== false) {
    await put('.thumbnails/2019-10-06 仪式.png', image);   // 点开头
    await put('thumbs/2019-10-06 仪式.png', image);        // 系统缩略图目录
    await put('日常/新建文件夹/2020-01-01.jpg.png', image); // .galleryignore 规则
    await put('~$说明.png', image);                        // Office 临时文件
    await put('日常/备注.txt', Buffer.from('不是素材'), '2020-01-01T12:00:00Z');
  }

  return {
    root,
    put,
    file: (rel) => path.join(root, ...rel.split('/')),
    abs: (rel) => path.join(root, ...rel.split('/')),
    async cleanup() {
      await fsp.rm(root, { recursive: true, force: true });
    }
  };
}

/** 临时缓存目录（缩略图、索引都写这里，测试结束整个删掉） */
async function buildCacheDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-cache-'));
  return {
    dir,
    async cleanup() {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * 起一个一次性服务器：先造素材库，再按临时目录加载 app
 *
 * config/scan/thumbs 都在 require 时读环境变量，所以必须「设好 env 再 require」。
 * 每个测试文件由 `node --test` 单独起进程，彼此不会串。
 *
 * @param {object} [options]
 * @param {string} [options.featured] featured.txt 的内容
 * @returns {Promise<{base: string, scan: object, app: object, media: object, close: Function}>}
 */
async function startTestServer(options = {}) {
  const media = await buildMediaRoot();
  const cache = await buildCacheDir();

  process.env.MEDIA_ROOT = media.root;
  process.env.CACHE_DIR = cache.dir;
  // 不管测不测精选，都必须把它指到临时目录：不指的话就会读到仓库里那份真的
  // featured.txt，测试看起来绿，其实断言的是这台电脑上的家庭照片
  const featuredFile = path.join(cache.dir, 'featured.txt');
  if (options.featured !== undefined) {
    await fsp.writeFile(featuredFile, options.featured, 'utf8');
  }
  process.env.FEATURED_FILE = featuredFile;

  // 清掉可能已经加载的实例，让它们按上面的 env 重来
  for (const name of ['config', 'scan', 'thumbs', 'app']) {
    delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'server', `${name}.js`))];
  }
  const config = require('../../server/config');
  const scan = require('../../server/scan');
  const app = require('../../server/app');

  // 三道门全部钉在临时目录里，漏一条就是「测试在碰真东西」
  for (const [key, value] of Object.entries({ mediaRoot: media.root, cacheDir: cache.dir, featuredFile })) {
    if (path.resolve(config[key]) !== path.resolve(value)) {
      throw new Error(`测试隔离失败：config.${key} 指向了 ${config[key]}，应该在 ${value} 里`);
    }
  }

  await scan.rescan({ force: true });
  // 正式启动时这件事在 index.js 里做，测试直接 listen 就要自己补上。
  // 刻意不调 detectFfmpeg()：没探过就认为没有 ffmpeg，视频走占位封面，
  // 测试不依赖本机装没装 ffmpeg，也不会去碰真文件。
  await app.__internals.loadFeatured();

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    app,
    scan,
    config,
    media,
    async close() {
      const closing = new Promise((resolve) => server.close(resolve));
      // fetch 的 keep-alive 连接不会自己散，不强行拆掉的话 close() 永远不返回
      server.closeAllConnections?.();
      await closing;
      await media.cleanup();
      await cache.cleanup();
    }
  };
}

/** 读一个小文件当文本用（断言「不该读到 package.json」时方便） */
function readIfExists(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 用裸 http 发一个请求
 *
 * 为什么不用 fetch：按 Fetch 规范，If-None-Match / If-Modified-Since 是
 * 「禁止设置的请求头」，undici 会默不作声地丢掉。要验协商缓存就必须自己写头。
 *
 * @param {string} base http://127.0.0.1:port
 * @param {string} url 路径
 * @param {object} [headers] 请求头
 * @returns {Promise<{status: number, headers: object, text: string}>}
 */
function raw(base, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: url, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { buildMediaRoot, buildCacheDir, startTestServer, readIfExists, raw, png };
