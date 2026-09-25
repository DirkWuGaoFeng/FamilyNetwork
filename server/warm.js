/**
 * 预热缩略图缓存
 *
 * 首次访问时每张缩略图都要现做（读 F 盘原图 + ffmpeg/sharp 处理，约 0.3~1 秒），
 * 首页一屏就是一百多张，家人第一次打开会等得很没耐心。这个脚本把首页与各相册
 * 封面会用到的那批图先跑一遍，之后都是毫秒级命中缓存。
 *
 *   node server/warm.js            # 预热首页与相册封面（约 600 张）
 *   node server/warm.js 800        # 顺便多预热一批最新照片的大图
 *
 * 注意：只预热「一定会被看到」的尺寸。每个宽度都是一次独立编码，什么都预热
 * 等于把 30GB 重做一遍。
 */
const config = require('./config');

const BASE = `http://127.0.0.1:${config.port}`;
const CONCURRENCY = 4;

async function json(url) {
  const res = await fetch(BASE + url);
  if (!res.ok) {
    throw new Error(`${res.status} ${url}`);
  }
  return res.json();
}

/** 指定位宽的缩略图地址（前端不同区块用的宽度不止默认那一个） */
function thumbUrl(item, width) {
  return `/thumb?p=${encodeURIComponent(item.path)}&w=${width}`;
}

/** 首页各区块实际会请求到的宽度（要和 app.js 里的 thumbAt 档位对上） */
const W = {
  grid: 480,      // 列表默认档
  rail: 620,      // 「最新的日子」、时间线小图、放大镜、拼贴右两格
  collage: 760,   // 首屏拼贴左上方那一格 + 相册详情瀑布流
  tile: 1000,     // 相册格封面、视频封面、灯箱偷看层
  banner: 1400,   // 相册页横幅、影像页主打
  hero: 1600      // 灯箱与首页横幅大图（就是 /api 里的 preview）
};

async function collectTargets(extraPhotos) {
  const urls = new Set();
  const add = (item, ...widths) => {
    if (item && item.path) {
      widths.forEach((w) => urls.add(thumbUrl(item, w)));
    }
  };

  const site = await json('/api/site');

  site.albums.forEach((album, i) => add(album.cover, i === 0 ? W.banner : W.tile, W.grid));

  const latest = await json(`/api/media?pageSize=${150 + extraPhotos}&kind=photo`);
  const photos = latest.items;
  photos.forEach((item) => add(item, W.grid, W.rail, W.collage));
  photos.slice(0, 40).forEach((item) => add(item, W.hero));

  // 首屏三格「活照片」每格堆三张轮换，全部要预热；加上那条横幅大图
  photos.slice(0, 12).forEach((item) => add(item, W.collage, W.rail));
  add(photos[3], W.hero);

  const videos = await json('/api/media?pageSize=40&kind=video');
  videos.items.forEach((item, i) => add(item, W.grid, W.tile, ...(i === 0 ? [W.banner] : [])));

  const timeline = await json('/api/timeline');
  const months = timeline.months.filter((m) => m.year === (timeline.years[0] || {}).year).slice(0, 12);
  for (const bucket of months) {
    const page = await json(`/api/media?month=${bucket.month}&pageSize=4`);
    page.items.forEach((item) => add(item, W.rail));
  }

  // 首页拼贴三格一共用 9 张精选（每格 3 张轮换），与 app.js 里的 limit 对齐
  const featured = await json('/api/featured?limit=9');
  featured.items.forEach((item) => add(item, W.rail, W.collage, W.hero));

  return [...urls];
}

async function warm(urls) {
  let done = 0;
  let failed = 0;
  const started = Date.now();

  async function worker(startIndex) {
    for (let i = startIndex; i < urls.length; i += CONCURRENCY) {
      try {
        const res = await fetch(BASE + urls[i]);
        if (!res.ok) {
          failed += 1;
        }
        await res.body?.cancel();
      } catch {
        failed += 1;
      }
      done += 1;
      if (done % 50 === 0) {
        const sec = Math.round((Date.now() - started) / 1000);
        const left = Math.round(((urls.length - done) / done) * sec);
        console.log(`  ${done}/${urls.length}（已用 ${sec}s，大约还要 ${left}s）`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`预热完成：${urls.length} 张，${sec}s${failed ? `，失败 ${failed} 张` : ''}`);
}

const extra = Number(process.argv[2]) || 0;
collectTargets(extra)
  .then((urls) => {
    console.log(`准备生成 ${urls.length} 张缩略图（并发 ${CONCURRENCY}）`);
    return warm(urls);
  })
  .catch((err) => {
    console.error(`预热失败：${err.message}\n要先开着服务（npm start）再跑这个脚本。`);
    process.exitCode = 1;
  });
