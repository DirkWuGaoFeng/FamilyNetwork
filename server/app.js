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
/** featured.txt 里 @开头 的行：置顶相册，让它排到相册列表与首页拼贴最前面 */
let pinnedAlbums = [];
/** @相册名=规则 的行：给某本相册指定封面（置顶也一并生效） */
let albumCovers = new Map();

/**
 * 读取 featured.txt：一行一个「路径片段或完整相对路径」，命中的素材按行序出现。
 * 以 @ 开头的行不是照片规则而是相册名（置顶），单独收走——否则它会被当成
 * 一段路径去匹配，既选不出照片，也白白占掉精选的一个位置。
 */
async function loadFeatured() {
  try {
    const text = await fsp.readFile(FEATURED_FILE, 'utf8');
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      // 去掉行内注释，与 .galleryignore 同一套语法
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter((line) => line && !line.startsWith('#'));
    featuredPaths = lines.filter((line) => !line.startsWith('@'));
    const at = lines.filter((line) => line.startsWith('@')).map((line) => line.slice(1));
    // @相册名 → 只置顶；@相册名=规则 → 置顶并指定封面。同一个相册写几行
    // 只算第一条（与精选规则「命中即取第一张」同一个脾气，免得改一行牵动另一行）
    pinnedAlbums = [...new Set(at.map((seg) => seg.split('=')[0].trim()).filter(Boolean))];
    const covers = new Map();
    for (const seg of at) {
      const eq = seg.indexOf('=');
      const name = eq < 0 ? '' : seg.slice(0, eq).trim();
      const rule = eq < 0 ? '' : seg.slice(eq + 1).trim();
      if (name && rule && !covers.has(name)) {
        covers.set(name, rule);
      }
    }
    albumCovers = covers;
  } catch {
    featuredPaths = [];
    pinnedAlbums = [];
    albumCovers = new Map();
  }
  return featuredPaths;
}

/**
 * 一条规则在给定素材里找第一个命中的：完整相对路径、文件名，或路径里的片段
 * （写「婚纱照/郭丽君」也能命中，取的是排在前面的那张）。
 * @param {Array<object>} pool 候选素材
 * @param {string} rule 规则原文
 * @param {Set<string>} [skip] 已经用过的路径，不再重复上榜
 * @returns {object|null}
 */
function matchByRule(pool, rule, skip) {
  const needle = rule.toLowerCase();
  return pool.find((item) => (!skip || !skip.has(item.path))
    && (item.path.toLowerCase() === needle
      || item.path.toLowerCase().includes(needle)
      || item.fileName.toLowerCase() === needle)) || null;
}

/**
 * 一本相册用哪张当封面。featured.txt 里 @相册名=规则 指定过就用那张，
 * 否则用扫描时挑的（最新的一张）。规则只在这本相册自己的照片里找，
 * 命不中不报错、退回自动挑的那张 —— 这是人手改的文件，路径打错太常见。
 * 只许挑照片：视频的封面图是一张带播放按钮的占位图，摆在本相册的位置上很难看。
 * @param {object} album 索引里的相册条目
 * @param {Array<object>} items 索引里的全部素材
 * @returns {object|null}
 */
function albumCover(album, items) {
  const rule = albumCovers.get(album.name);
  if (rule) {
    const pool = items.filter((item) => item.album === album.name && item.kind === 'photo')
      .sort((a, b) => b.time - a.time);
    const hit = matchByRule(pool, rule);
    if (hit) {
      return hit;
    }
  }
  return album.cover || null;
}

/**
 * featured.txt 里的规则到底点没点得到东西。
 * 「改了没反应」是最难查的一种坑：路径打错一个字、或者压根没重启服务，
 * 站点会安静地按旧样子显示，人完全看不出哪里不对。启动时和刷新时各扫
 * 一遍，有落空的规则就打到控制台（不抛错，不阻断启动）。
 * @returns {Array<string>} 每条问题一行话；空数组 = 都没问题
 */
function auditFeaturedRules() {
  const index = scan.getIndex();
  if (!index || !Array.isArray(index.items)) return [];
  const hasAlbum = (name) => index.albums.some((album) => album.name === name);
  const problems = [];
  for (const name of pinnedAlbums) {
    // 写了 @相册名=规则 的，下面封面那段会报得更准，这里不重复说
    if (!albumCovers.has(name) && !hasAlbum(name)) {
      problems.push(`@${name}：没有这本相册（文件夹名要一模一样）`);
    }
  }
  for (const [name, rule] of albumCovers) {
    if (!hasAlbum(name)) {
      problems.push(`@${name}=…：没有这本相册（文件夹名要一模一样）`);
      continue;
    }
    const pool = index.items.filter((item) => item.album === name && item.kind === 'photo');
    if (!matchByRule(pool, rule)) {
      problems.push(`@${name}=${rule}：在「${name}」的照片里找不到（视频不能当封面）`);
    }
  }
  for (const path of featuredPaths) {
    if (!matchByRule(index.items, path)) problems.push(`${path}：索引里找不到这个文件`);
  }
  return problems;
}

/**
 * 置顶相册按清单里的顺序排到最前，其余保持原样（按最近时间倒序）。
 * 清单里写了但不存在的相册名直接被忽略，不报错——手改的文件，名字打错很常见。
 * @param {Array<object>} albums 索引给出的相册列表（已按最近时间倒序）
 * @returns {Array<object>}
 */
function orderAlbums(albums) {
  if (!pinnedAlbums.length) {
    return albums;
  }
  const rank = new Map(pinnedAlbums.map((name, i) => [name, i]));
  // 没置顶的相册统一给一个末位名次：彼此相减就是 0，等于保持原序
  // （不拿 Infinity 相减，两个 Infinity 会算出 NaN，比较结果就成了噪声）
  const last = albums.length;
  const rankOf = (name) => (rank.has(name) ? rank.get(name) : last);
  return albums.slice().sort((a, b) => rankOf(a.name) - rankOf(b.name));
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
    const hit = matchByRule(photos, rule, used);
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
    albums: orderAlbums(index.albums).map((album) => {
      // 封面可能被 featured.txt 的 @相册名=规则 换过，不直接拿索引里挑的那张
      const cover = albumCover(album, index.items);
      return {
        name: album.name,
        count: album.count,
        photos: album.photos,
        videos: album.videos,
        size: album.size,
        years: album.years,
        folders: album.folders,
        folderCount: album.folderCount,
        // 相册级最近时间：首页格子悬停那行“最近 …”要用，漏了前端永远渲染成破折号
        latest: album.latest,
        cover: cover ? decorate(cover) : null
      };
    }),
    // 首页靠这几个字段决定拼贴用什么：featured=false 时它走「一本相册一格」的老路子
    featured: featuredPaths.length > 0,
    pinned: pinnedAlbums,
    // 哪几本相册的封面是人指定的（只看键，规则原文不外泄）：排查「封面怎么不对」用
    covers: [...albumCovers.keys()],
    // 有 ffmpeg 才做得了动图，前端据此决定要不要露出那个按钮
    anim: hasFfmpeg(),
    generatedAt: index.generatedAt
  });
});

/** 背景音乐：列出 bgm 文件夹里的音频，前端整夹循环播放。目录不存在或为空就返回空表 */
app.get('/api/bgm', async (req, res) => {
  const dir = path.join(config.mediaRoot, config.bgmFolder);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    // 没建这个文件夹（或盘没插）不是错，前端据此隐藏播放控件
    return res.json({ folder: config.bgmFolder, defaultVolume: config.bgmVolume, count: 0, tracks: [] });
  }
  const tracks = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!config.audioExtensions.includes(ext)) {
      continue;
    }
    if (name.startsWith('.') || name.startsWith('~$')) {
      continue;
    }
    const rel = `${config.bgmFolder}/${name}`;
    let size = 0;
    try {
      size = (await fsp.stat(path.join(dir, name))).size;
    } catch {
      continue;   // 正被占用或刚删掉的文件，跳过就好
    }
    tracks.push({
      name,
      // 展示名：去掉扩展名、把下划线换成空格（很多文件名用 _ 分词）
      title: path.basename(name, ext).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim() || name,
      // 与照片/视频同一套路：相对路径整体编码后交给 /media 同源直出（带 Range）
      url: `/media/${encodeURIComponent(rel)}`,
      size
    });
  }
  tracks.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  res.json({ folder: config.bgmFolder, defaultVolume: config.bgmVolume, count: tracks.length, tracks });
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
    scan.rescan({ force: true })
      .then(() => {
        // 扫完再查：这时索引才是新的，新拷进来的照片不会白白被报「找不到」
        for (const line of auditFeaturedRules()) console.warn(`[featured.txt] ${line}`);
      })
      .catch((err) => console.error('[api] 手动刷新失败:', err.message));
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
    if (/\.(mp4|m4v|webm|ogv|mov|mp3|m4a|aac|ogg|oga|opus|flac|wav)$/i.test(filePath)) {
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
module.exports.__internals = { decorate, safeResolve, resolveFeatured, loadFeatured, auditFeaturedRules, findByAbsolute, clampPaging, featuredFile: FEATURED_FILE };
