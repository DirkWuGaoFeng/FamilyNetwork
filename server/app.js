/**
 * HTTP 层：路由、响应头、错误处理
 *
 * 与 index.js 分开放，只是为了能被测试直接 require（不必真的占用端口、
 * 不必先扫完 3700 个素材才能跑起来看行为）。这里没有启动逻辑。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const config = require('./config');
const scan = require('./scan');
const { getThumb, videoInfo, makeAnim, hasFfmpeg } = require('./thumbs');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FEATURED_FILE = config.featuredFile;
const ANIM_DIR = path.join(config.cacheDir, 'anim');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

const startedAt = Date.now();

const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');

// ---------------------------------------------------------------------------
// 通用中间件
// ---------------------------------------------------------------------------

/**
 * 安全头
 *
 * 这个站没有登录，也就没有会话可偷；防的主要是「被人 iframe 走」「拿到一个
 * 奇怪的 Content-Type 当脚本执行」这类顺路的把戏。
 * style-src 需要 unsafe-inline：页面里有一整块内联 <style>，元素上也挂着
 * style 属性（错落拼贴与错开延迟都靠它）。script 侧没有一行内联脚本。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "frame-ancestors 'self'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/** 接口给的是内存索引，重扫之后必须立刻看到新结果，所以一律不缓存 */
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * 请求日志：默认只报「慢」和「错」。
 * 家庭机上没人想看一万行 200 /thumb，但首屏卡住时，这一行就是唯一的线索。
 */
app.use((req, res, next) => {
  // 静态资源与大图 Range 请求量很大，日志只关心我们自己的路由
  const trackable = req.path.startsWith('/api') || req.path === '/thumb' || req.path === '/healthz';
  if (!config.logAllRequests && !trackable) {
    return next();
  }
  const began = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - began;
    const bad = res.statusCode >= 400;
    if (!config.logAllRequests && !bad && ms < config.slowRequestMs) {
      return;
    }
    const tag = bad ? ' ! ' : ' ~ ';
    console.log(`[http]${tag}${res.statusCode} ${req.method} ${req.originalUrl} ${ms}ms`);
  });
  next();
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 首页精选（featured.txt 解析出来的规则），为空时相关接口退化成「最新的 N 张」 */
let featuredPaths = [];

/**
 * 读取 featured.txt：一行一个「路径片段或完整相对路径」，命中的素材按行序出现
 */
async function loadFeatured() {
  try {
    const text = await fsp.readFile(FEATURED_FILE, 'utf8');
    featuredPaths = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      // 去掉行内注释，与 .galleryignore 同一套语法
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    featuredPaths = [];
  }
  return featuredPaths;
}

/**
 * 把「精选规则」翻译成具体素材：每条规则取第一个命中的文件，避免同一张图重复上榜
 * @param {number} limit
 * @returns {Array<object>}
 */
function resolveFeatured(limit) {
  const items = scan.getIndex().items;
  const photos = items.filter((item) => item.kind === 'photo');
  const picked = [];
  const used = new Set();

  for (const rule of featuredPaths) {
    const needle = rule.toLowerCase();
    const hit = photos.find((item) => !used.has(item.path)
      && (item.path.toLowerCase() === needle
        || item.path.toLowerCase().includes(needle)
        || item.fileName.toLowerCase() === needle));
    if (hit) {
      picked.push(hit);
      used.add(hit.path);
    }
    if (picked.length >= limit) {
      break;
    }
  }
  if (picked.length === 0) {
    return photos.slice(0, limit);
  }
  // 精选不足一屏时，用最新照片补齐，页面永远不会空着
  if (picked.length < limit) {
    for (const item of photos) {
      if (picked.length >= limit) {
        break;
      }
      if (!used.has(item.path)) {
        picked.push(item);
        used.add(item.path);
      }
    }
  }
  return picked;
}

/**
 * 把索引条目加工成前端直接可用的对象（带上三个 URL）
 * @param {object} item
 * @returns {object}
 */
function decorate(item) {
  const enc = encodeURIComponent(item.path);
  return {
    path: item.path,
    name: item.name,
    kind: item.kind,
    album: item.album,
    folder: item.folder,
    sub: item.sub,
    date: item.date,
    size: item.size,
    url: `/media/${enc}`,
    thumb: `/thumb?p=${enc}&w=${config.thumbWidth}`,
    preview: `/thumb?p=${enc}&w=${config.previewWidth}`
  };
}

/**
 * 校验并解析相对路径，禁止越出素材根目录
 *
 * 这是整站唯一接收「任意路径」入口的地方，所以宁可死板：先解出绝对路径，
 * 再要求它一定以「素材根 + 分隔符」开头。少了那个分隔符，
 * f:\照片 会放过 f:\照片其他东西 这种邻居目录。
 *
 * @param {string} rel 客户端传来的相对路径
 * @returns {string|null} 绝对路径，非法时为 null
 */
function safeResolve(rel) {
  if (typeof rel !== 'string' || !rel.trim()) {
    return null;
  }
  let decoded = rel;
  // 允许一次编码（前端 encodeURIComponent 过），但解完必须不再含编码痕迹
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || /\.\.[/\\]/.test(decoded.replace(/\\/g, '/'))) {
    return null;
  }
  const cleaned = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(config.mediaRoot, cleaned);
  const rootPrefix = path.resolve(config.mediaRoot) + path.sep;
  if (!abs.startsWith(rootPrefix)) {
    return null;
  }
  return abs;
}

/**
 * 按绝对路径找索引条目（缩略图需要知道它是视频还是照片）
 * @param {string} abs
 * @returns {object|null}
 */
function findByAbsolute(abs) {
  const rel = path.relative(config.mediaRoot, abs).split(path.sep).join('/');
  return scan.getIndex().items.find((item) => item.path === rel) || null;
}

/** 统一的分页参数夹逼，避免一次把整个索引泼给浏览器 */
function clampPaging(query) {
  return {
    page: Math.max(1, Number(query.page) || 1),
    pageSize: Math.min(config.maxPageSize, Math.max(1, Number(query.pageSize) || config.pageSize))
  };
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

/** 健康检查：给部署脚本、开机自启和「家里网通畅不通」用 */
app.get('/healthz', (req, res) => {
  const index = scan.getIndex();
  let cacheWritable = false;
  try {
    fs.accessSync(config.cacheDir, fs.constants.W_OK);
    cacheWritable = true;
  } catch {
    cacheWritable = false;
  }
  res.json({
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    items: index.stats.total || index.items.length,
    photos: index.stats.photos,
    videos: index.stats.videos,
    albums: index.albums.length,
    generatedAt: index.generatedAt,
    ffmpeg: hasFfmpeg(),
    cacheWritable
  });
});

/** 站点信息：标题、统计、相册概览，前端一次拿到够渲染导航和首页的东西 */
app.get('/api/site', (req, res) => {
  const index = scan.getIndex();
  res.json({
    title: config.siteTitle,
    subtitle: config.siteSubtitle,
    // 页脚只报目录名，不把整条本地路径交给浏览器
    rootName: path.basename(config.mediaRoot),
    stats: index.stats,
    years: index.years,
    albums: index.albums.map((album) => ({
      name: album.name,
      count: album.count,
      photos: album.photos,
      videos: album.videos,
      size: album.size,
      years: album.years,
      folders: album.folders,
      folderCount: album.folderCount,
      cover: album.cover ? decorate(album.cover) : null
    })),
    featured: featuredPaths.length > 0,
    // 有 ffmpeg 才做得了动图，前端据此决定要不要露出那个按钮
    anim: hasFfmpeg(),
    generatedAt: index.generatedAt
  });
});

/** 素材查询：相册、时间线、搜索、视频页共用这一个接口 */
app.get('/api/media', (req, res) => {
  const paging = clampPaging(req.query);
  const result = scan.query({
    album: req.query.album,
    folder: req.query.folder,
    kind: req.query.kind,
    year: req.query.year,
    month: req.query.month,
    q: req.query.q,
    sort: req.query.sort,
    page: paging.page,
    pageSize: paging.pageSize
  });
  res.json({
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    pages: result.pages,
    hasMore: result.page < result.pages,
    items: result.items.map(decorate)
  });
});

/** 精选（featured.txt） */
app.get('/api/featured', (req, res) => {
  const limit = Math.min(60, Number(req.query.limit) || config.featuredLimit);
  const picked = resolveFeatured(limit);
  res.json({
    total: picked.length,
    page: 1,
    pageSize: limit,
    pages: 1,
    hasMore: false,
    items: picked.map(decorate),
    rules: featuredPaths.length
  });
});

/** 时间线（按年月倒序，带封面） */
app.get('/api/timeline', (req, res) => {
  const index = scan.getIndex();
  const byPath = new Map(index.items.map((item) => [item.path, item]));
  res.json({
    years: index.years,
    months: index.timeline.map((bucket) => ({
      month: bucket.month,
      year: bucket.year,
      count: bucket.count,
      photos: bucket.photos,
      videos: bucket.videos,
      cover: bucket.cover && byPath.get(bucket.cover) ? decorate(byPath.get(bucket.cover)) : null
    }))
  });
});

/** 手动触发重新扫描（新增照片后不用重启服务） */
app.post('/api/refresh', async(req, res, next) => {
  try {
    await loadFeatured();
    scan.rescan({ force: true }).catch((err) => console.error('[api] 手动刷新失败:', err.message));
    res.json({ ok: true, message: '已开始重新扫描，稍后刷新页面即可' });
  } catch (err) {
    next(err);
  }
});

/** 视频卡片上的时长角标（顺便提前把这个视频的封面帧抽好） */
app.get('/api/video-info', async(req, res) => {
  const abs = safeResolve(req.query.p);
  const item = abs && findByAbsolute(abs);
  if (!item || item.kind !== 'video') {
    return res.status(404).json({ message: '找不到这个视频' });
  }
  try {
    res.json(await videoInfo(item));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * 把一段视频做成循环动图。第一次要 ffmpeg 跑几秒，所以先返回 JSON 里的地址，
 * 图片本身走 /anim（缓存文件名带原图修改时间，可以放心挂一年）
 */
app.get('/api/anim', async(req, res) => {
  const abs = safeResolve(req.query.p);
  const item = abs && findByAbsolute(abs);
  if (!item || item.kind !== 'video') {
    return res.status(404).json({ message: '找不到这个视频' });
  }
  if (!hasFfmpeg()) {
    return res.status(503).json({ message: '这台机器上没有可用的 ffmpeg，做不了动图' });
  }
  try {
    const width = Math.min(800, Math.max(320, Number(req.query.w) || 560));
    const file = await makeAnim(item, width);
    res.json({ url: `/anim/${path.basename(file.file)}`, width });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** 动图文件：只允许缓存目录里那几个十六进制文件名，不接受任何路径分隔符 */
app.get('/anim/:file', (req, res) => {
  if (!/^[0-9a-f]{40}\.webp$/.test(req.params.file)) {
    return res.status(400).end();
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(path.join(ANIM_DIR, req.params.file), (err) => {
    if (err && !res.headersSent) {
      res.status(404).end();
    }
  });
});

/**
 * 缩略图。缓存文件名带原图修改时间与宽度，所以可以放心地写「一年不变」
 */
app.get('/thumb', async(req, res) => {
  const abs = safeResolve(req.query.p);
  if (!abs) {
    return res.status(400).end();
  }
  const width = Math.min(config.previewWidth * 2, Math.max(80, Number(req.query.w) || config.thumbWidth));
  const item = findByAbsolute(abs)
    // 索引刚重扫完、旧 URL 还在页面里时，按路径现场造一个条目，图不会裂
    || { path: path.relative(config.mediaRoot, abs).split(path.sep).join('/'), kind: 'photo', mtimeMs: 0 };

  try {
    const thumb = await getThumb(item, width);
    if (thumb && thumb.svg) {
      // 视频抽不了帧（没装 ffmpeg、文件坏）时给占位图，不能重定向到视频本身
      res.setHeader('Content-Type', thumb.type);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).end(thumb.svg);
    }
    if (!thumb || !fs.existsSync(thumb.file)) {
      // 原图损坏或格式不认识时，直接把原图给出去，至少页面不留白
      return res.redirect(307, `/media/${encodeURIComponent(item.path)}`);
    }
    res.setHeader('Content-Type', thumb.type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(thumb.file);
  } catch (err) {
    console.error('[thumb] 异常:', err.message);
    return res.status(500).end();
  }
});

// ---------------------------------------------------------------------------
// 静态资源
// ---------------------------------------------------------------------------

/**
 * 原图与视频。express.static 自带 Range 支持，几百 MB 的视频在浏览器里可以直接拖进度条
 */
app.use('/media', express.static(config.mediaRoot, {
  index: false,
  dotfiles: 'deny',
  maxAge: '1d',
  fallthrough: true,
  setHeaders: (res, filePath) => {
    if (/\.(mp4|m4v|webm|ogv|mov)$/i.test(filePath)) {
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

/**
 * 前端壳：没有构建步骤，拿不到内容指纹，所以 index.html 与 JS 都不能长挂——
 * 否则改完代码刷新还是旧那一版（靠 ETag 重验证，304 只有几百字节）。
 * 图标、manifest 这类不常动的才吃一天缓存。
 */
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (/\.(js|html)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(css|webmanifest|png|svg|ico|webp)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// 兜底：接口 404 返回 JSON，其余交给单页
app.use('/api', (req, res) => res.status(404).json({ message: '接口不存在' }));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(INDEX_HTML, (err) => {
    if (err && !res.headersSent) {
      res.status(500).type('text/plain; charset=utf-8')
        .send('页面文件读不出来：public/index.html 还在吗？');
    }
  });
});

/** 最后的错误兜底：接口给 JSON，页面给一句人话，绝不把堆栈甩给家人看 */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const way = `${req.method} ${req.originalUrl}`;
  console.error(`[http] 未处理异常 ${way}: ${err && err.message}`);
  if (req.path.startsWith('/api') || req.path === '/healthz') {
    return res.status(500).json({ message: '服务内部错误' });
  }
  return res.status(500).type('text/plain; charset=utf-8').end('出了点问题，刷新一下试试。');
});

module.exports = app;
module.exports.app = app;
// 下面这些不是给浏览器用的，是给测试用的
module.exports.__internals = { decorate, safeResolve, resolveFeatured, loadFeatured, findByAbsolute, clampPaging, featuredFile: FEATURED_FILE };
