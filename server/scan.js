/**
 * 素材索引：把磁盘上的照片/视频目录变成可查询的内存索引
 *
 * 这是全站唯一的数据来源——没有数据库。索引结果同时缓存到 .cache/index.json，
 * 所以服务重启是秒开的；素材有增删时，等自动刷新（默认 10 分钟）或点页面右上角的刷新。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');

/** 索引缓存文件 */
const INDEX_FILE = path.join(config.cacheDir, 'index.json');

/** 排除规则文件（一行一个规则，# 开头是注释） */
const IGNORE_FILE = path.join(__dirname, '..', '.galleryignore');

/** 无论配置如何都不该出现在网页上的目录名 */
const ALWAYS_SKIP = new Set([
  '@ea-doc', '@eaDir', '#recycle', 'thumbs', '.thumbnails',
  'new1', 'temp', 'tmp', '系统保留'
]);

/** 缓存的排除规则 */
let ignoreRules = null;

/** 内存中的当前索引 */
let current = {
  generatedAt: 0,
  root: config.mediaRoot,
  items: [],
  albums: [],
  timeline: [],
  years: [],
  stats: { photos: 0, videos: 0, total: 0, totalBytes: 0, folders: 0, albums: 0, years: [] }
};

let scanning = null;

/**
 * 读取 .galleryignore
 * @returns {Promise<Array<string>>} 规则列表
 */
async function loadIgnoreRules() {
  try {
    const text = await fsp.readFile(IGNORE_FILE, 'utf8');
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      // 去掉行内注释
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (err) {
    return [];
  }
}

/**
 * 判断某个相对路径是否被排除
 * @param {string} relPosix 相对素材根目录的路径，使用 / 分隔
 * @param {string} baseName 目录或文件名
 * @returns {boolean}
 */
function isIgnored(relPosix, baseName) {
  const lower = relPosix.toLowerCase();
  if (baseName.startsWith('.') || baseName.startsWith('~$')) {
    return true;
  }
  if (ALWAYS_SKIP.has(baseName.toLowerCase())) {
    return true;
  }
  return (ignoreRules || []).some((rule) => {
    const needle = rule.toLowerCase();
    // 带斜杠的规则按整条路径匹配，不带的按任一层目录名匹配
    if (needle.includes('/')) {
      return lower.includes(needle.replace(/\/$/, ''));
    }
    return baseName.toLowerCase() === needle || lower.includes(`/${needle}/`) || lower.includes(`/${needle}`);
  });
}

/**
 * 按扩展名判断素材类型
 * @param {string} fileName
 * @returns {'photo'|'video'|null}
 */
function kindOf(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (config.photoExtensions.includes(ext)) {
    return 'photo';
  }
  if (config.videoExtensions.includes(ext)) {
    return 'video';
  }
  return null;
}

/** 「日期」分支的合法区间：1990 年以前的文件名多是瞎写的，不如不用 */
const MIN_DAY_TS = Date.UTC(1990, 0, 1);
/** 13 位毫秒时间戳必然在这个时刻之后（2001-09-09），拿这个下限挡住误命中 */
const MIN_EPOCH_TS = Date.UTC(2001, 8, 9);

/**
 * 推断素材的拍摄/产生时间
 *
 * 依次尝试：文件名里的 YYYYMMDD → 文件名里的 13 位毫秒时间戳（微信照片常见）→
 * 上层目录名里的 YYYYMMDD → 文件修改时间。家庭照片库里绝大多数能被前三步命中。
 *
 * @param {string} fileName 文件名
 * @param {Array<string>} folderNames 从近到远的各级目录名
 * @param {number} mtimeMs 文件修改时间
 * @returns {{date: string, time: number, source: string}}
 */
function inferDate(fileName, folderNames, mtimeMs) {
  const haystacks = [path.basename(fileName, path.extname(fileName)), ...folderNames];

  for (const text of haystacks) {
    // 20191006 / 2019-10-06 / 2019_10_06
    // 两侧都不能再贴数字：否则快手那种长数字串（0812400607203bd81893772）里，
    // 随手一段就能命中 20060720，凭空造出一个日期来
    const dated = text.match(/(?<!\d)(19|20)(\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/);
    if (dated) {
      const year = Number(`${dated[1]}${dated[2]}`);
      const month = Number(dated[3]);
      const day = Number(dated[4]);
      const ts = Date.UTC(year, month - 1, day);
      if (ts >= MIN_DAY_TS && ts <= Date.now() + 86400000) {
        return { date: isoDay(ts), time: ts, source: 'filename' };
      }
    }

    // wx_camera_1514953916330 / mmexport1602316522535
    // 必须是完整的一段 13 位数字、而且以 1 开头：快手那类文件名（0812400607203bd81893772）
    // 开头就是 13 位，但它不是时间戳，不卡住会算出 1995 年这种鬼日期
    const epoch = text.match(/(?<!\d)(1\d{12})(?!\d)/);
    if (epoch) {
      const ts = Number(epoch[1]);
      if (ts >= MIN_EPOCH_TS && ts <= Date.now() + 86400000) {
        return { date: isoDay(ts), time: ts, source: 'filename' };
      }
    }
  }

  return { date: isoDay(mtimeMs), time: mtimeMs, source: 'mtime' };
}

/**
 * 时间戳转 YYYY-MM-DD
 * @param {number} ts
 * @returns {string}
 */
function isoDay(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  // 用本地时区，避免晚上拍的照片被算到前一天
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 直接注入排除规则（只给测试用，正常流程走 loadIgnoreRules）
 * @param {Array<string>} rules
 */
function setIgnoreRules(rules) {
  ignoreRules = rules;
}

/**
 * 递归遍历目录
 * @param {string} dir 绝对路径
 * @param {string} relPrefix 相对路径前缀（/ 分隔）
 * @param {Array<string>} folderNames 各级目录名，由近到远
 * @param {Array<object>} out 收集结果
 */
async function walk(dir, relPrefix, folderNames, out) {
  let handle;
  try {
    handle = await fsp.opendir(dir);
  } catch (err) {
    return;
  }
  for await (const entry of handle) {
    const abs = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (isIgnored(`${rel}/`, entry.name)) {
        continue;
      }
      await walk(abs, rel, [entry.name, ...folderNames], out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const kind = kindOf(entry.name);
    if (!kind) {
      continue;
    }
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch (err) {
      continue;
    }
    if (isIgnored(rel, entry.name)) {
      continue;
    }
    const when = inferDate(entry.name, folderNames, stat.mtimeMs);
    const album = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '未分类';
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    out.push({
      path: rel,
      name: path.basename(entry.name, path.extname(entry.name)),
      fileName: entry.name,
      kind,
      album,
      folder,
      sub: folder.includes('/') ? folder.slice(folder.indexOf('/') + 1) : '',
      size: stat.size,
      date: when.date,
      time: when.time,
      dateSource: when.source,
      modified: isoDay(stat.mtimeMs),
      mtimeMs: stat.mtimeMs
    });
  }
}

/**
 * 汇总相册列表（一个顶层目录 = 一个相册）
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
function buildAlbums(items) {
  const byAlbum = new Map();
  for (const item of items) {
    if (!byAlbum.has(item.album)) {
      byAlbum.set(item.album, { name: item.album, items: [] });
    }
    byAlbum.get(item.album).items.push(item);
  }

  const albums = [];
  for (const group of byAlbum.values()) {
    const sorted = group.items.slice().sort((a, b) => b.time - a.time);
    const folders = new Map();
    for (const item of group.items) {
      const key = item.sub || '全部';
      if (!folders.has(key)) {
        folders.set(key, { name: key, count: 0, photos: 0, videos: 0, latest: 0 });
      }
      const folder = folders.get(key);
      folder.count += 1;
      if (item.kind === 'photo') {
        folder.photos += 1;
      } else {
        folder.videos += 1;
      }
      folder.latest = Math.max(folder.latest, item.time);
    }
    const years = new Set(group.items.map((item) => item.date.slice(0, 4)));
    albums.push({
      name: group.name,
      count: group.items.length,
      photos: group.items.filter((item) => item.kind === 'photo').length,
      videos: group.items.filter((item) => item.kind === 'video').length,
      size: group.items.reduce((sum, item) => sum + item.size, 0),
      cover: pickCover(sorted),
      folderCount: folders.size,
      folders: [...folders.values()].sort((a, b) => b.latest - a.latest),
      years: [...years].sort(),
      earliest: group.items.reduce((min, item) => Math.min(min, item.time), Infinity),
      latest: sorted.length ? sorted[0].time : 0
    });
  }
  // 最新的相册排在前面，符合「先看到最近的日子」的直觉
  return albums.sort((a, b) => b.latest - a.latest);
}

/**
 * 挑一张做封面：最新的、体积不太小的照片（太小的多是聊天截图），一张照片都没有才用视频
 * @param {Array<object>} sortedByNewest 按时间倒序的素材
 * @returns {object|null}
 */
function pickCover(sortedByNewest) {
  const photos = sortedByNewest.filter((item) => item.kind === 'photo');
  return photos.find((item) => item.size >= 150 * 1024) || photos[0] || sortedByNewest[0] || null;
}

/**
 * 汇总时间线（按年、月）
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
function buildTimeline(items) {
  const months = new Map();
  for (const item of items) {
    const key = item.date.slice(0, 7);
    if (!months.has(key)) {
      months.set(key, { month: key, year: key.slice(0, 4), count: 0, photos: 0, videos: 0, cover: null, latest: 0 });
    }
    const bucket = months.get(key);
    bucket.count += 1;
    bucket[`${item.kind}s`] += 1;
    if (bucket.cover === null || (item.kind === 'photo' && bucket.cover.kind !== 'photo')) {
      bucket.cover = item;
    }
    bucket.latest = Math.max(bucket.latest, item.time);
  }
  const list = [...months.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
  const years = new Map();
  for (const bucket of list) {
    if (!years.has(bucket.year)) {
      years.set(bucket.year, { year: bucket.year, count: 0, months: [] });
    }
    const year = years.get(bucket.year);
    year.count += bucket.count;
    year.months.push(bucket.month);
  }
  return { months: list.map((bucket) => ({ ...bucket, cover: bucket.cover.path })), years: [...years.values()] };
}

/**
 * 重新扫描素材目录，重建索引
 * @param {object} [options]
 * @param {boolean} [options.force] 忽略「正在扫描」直接来一遍
 * @returns {Promise<object>} 当前索引
 */
async function rescan({ force = false } = {}) {
  if (scanning && !force) {
    return scanning;
  }
  ignoreRules = await loadIgnoreRules();
  const started = Date.now();

  const job = (async () => {
    await fsp.mkdir(config.cacheDir, { recursive: true });
    const items = [];
    await walk(config.mediaRoot, '', [], items);
    // 时间倒序为主序，同一天内按路径排，保证分页时顺序稳定
    items.sort((a, b) => (b.time - a.time) || (a.path < b.path ? -1 : 1));

    const timeline = buildTimeline(items);
    const next = {
      generatedAt: Date.now(),
      root: config.mediaRoot,
      items,
      albums: buildAlbums(items),
      timeline: timeline.months,
      years: timeline.years,
      stats: {
        photos: items.filter((item) => item.kind === 'photo').length,
        videos: items.filter((item) => item.kind === 'video').length,
        total: items.length,
        totalBytes: items.reduce((sum, item) => sum + item.size, 0),
        folders: new Set(items.map((item) => item.folder)).size,
        albums: new Set(items.map((item) => item.album)).size,
        firstDate: items.length ? items[items.length - 1].date : null,
        lastDate: items.length ? items[0].date : null,
        scanMs: Date.now() - started
      }
    };

    // 写缓存是「尽力而为」：失败不影响服务，只是下次启动要重新扫
    try {
      await fsp.writeFile(INDEX_FILE, JSON.stringify(next), 'utf8');
    } catch (err) {
      console.warn('[scan] 索引缓存写入失败:', err.message);
    }
    current = next;
    console.log(`[scan] 索引 ${next.items.length} 个素材（${next.stats.photos} 照片 / ${next.stats.videos} 视频），`
      + `${next.albums.length} 个相册，耗时 ${next.stats.scanMs}ms`);
    return current;
  })();

  scanning = job.finally(() => {
    scanning = null;
  });
  return scanning;
}

/**
 * 启动时加载索引：先用磁盘上的缓存秒开，过期了再后台补扫
 */
async function init() {
  try {
    const cached = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8'));
    if (cached && cached.root === config.mediaRoot && Array.isArray(cached.items)) {
      current = cached;
      // 老缓存里的派生字段可能随代码变化而过期，这里统一重算一遍（毫秒级）
      current.albums = buildAlbums(current.items);
      const timeline = buildTimeline(current.items);
      current.timeline = timeline.months;
      current.years = timeline.years;
      console.log(`[scan] 已载入缓存索引：${current.items.length} 个素材`
        + `（上次扫描于 ${new Date(current.generatedAt).toLocaleString('zh-CN')}）`);
    }
  } catch (err) {
    console.log('[scan] 没有可用缓存，将做一次完整扫描');
  }

  if (Date.now() - current.generatedAt > config.rescanIntervalMs) {
    await rescan();
  } else {
    // 缓存还新，但也别让用户等到下次重启才看到新照片
    rescan().catch((err) => console.error('[scan] 后台刷新失败:', err.message));
  }
  setInterval(() => {
    rescan().catch((err) => console.error('[scan] 定时刷新失败:', err.message));
  }, config.rescanIntervalMs);
}

/**
 * 查询素材
 * @param {object} params 查询条件
 * @param {string} [params.album] 顶层目录名
 * @param {string} [params.folder] 完整子目录路径
 * @param {string} [params.kind] photo / video
 * @param {string} [params.year] YYYY
 * @param {string} [params.month] YYYY-MM
 * @param {string} [params.q] 关键词（匹配文件名与目录名）
 * @param {number} [params.page]
 * @param {number} [params.pageSize]
 * @param {string} [params.sort] newest / oldest / name
 * @param {Array<string>} [params.paths] 只取这些路径（首页精选用）
 * @returns {{total: number, page: number, pageSize: number, pages: number, items: Array<object>}}
 */
function query(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(config.maxPageSize, Math.max(1, Number(params.pageSize) || config.pageSize));
  let items = current.items;

  if (params.paths && params.paths.length) {
    const wanted = new Set(params.paths);
    items = items.filter((item) => wanted.has(item.path));
  }
  if (params.album) {
    items = items.filter((item) => item.album === params.album);
  }
  if (params.folder) {
    const folder = String(params.folder);
    items = items.filter((item) => item.folder === folder || item.folder.startsWith(`${folder}/`));
  }
  if (params.kind === 'photo' || params.kind === 'video') {
    items = items.filter((item) => item.kind === params.kind);
  }
  if (params.year) {
    items = items.filter((item) => item.date.startsWith(params.year));
  }
  if (params.month) {
    items = items.filter((item) => item.date.startsWith(params.month));
  }
  if (params.q) {
    const needle = String(params.q).trim().toLowerCase();
    if (needle) {
      items = items.filter((item) => item.path.toLowerCase().includes(needle));
    }
  }

  const all = params.sort === 'oldest'
    ? items.slice().sort((a, b) => a.time - b.time)
    : (params.sort === 'name' ? items.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) : items);

  const total = all.length;
  const start = (page - 1) * pageSize;
  return {
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: all.slice(start, start + pageSize)
  };
}

module.exports = {
  init,
  rescan,
  query,
  getIndex: () => current,
  indexFile: INDEX_FILE,
  /**
   * 下面几个是给测试用的纯函数（也方便以后把扫描拆成独立工具）。
   * 日期推断与排除规则是整个索引里最容易悄悄错坏的地方，
   * 一旦错就会凭空造出 1995 年这种日期，必须能单独验。
   */
  internals: { inferDate, isIgnored, kindOf, buildAlbums, buildTimeline, pickCover, setIgnoreRules, isoDay }
};
