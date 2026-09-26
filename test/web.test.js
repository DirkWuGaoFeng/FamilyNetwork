/**
 * HTTP 层：接口契约、响应头、路径越权
 *
 * 这个站跑在局域网里、没有登录，任何一个能连上端口的人都是「已认证用户」，
 * 所以边界全靠这一层守住：路径不能越出素材目录、接口不能把整库一次吐出去、
 * 出错不能把堆栈甩到浏览器里。这几件事都必须有测试钉着。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { startTestServer, raw } = require('./helpers/fixtures');

/** 小助手：发一个请求，顺手把 JSON 解好 */
async function get(base, url, init) {
  const res = await fetch(`${base}${url}`, init);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, type, body };
}

test('索引与素材库一致：该收的收下，该排的排掉', async () => {
  const svc = await startTestServer();
  try {
    const index = svc.scan.getIndex();
    assert.equal(index.items.length, 9, '七个好文件 + 一个假日期 + 一个坏图');
    assert.equal(index.stats.photos, 8);
    assert.equal(index.stats.videos, 1);
    assert.deepEqual(index.albums.map((a) => a.name), ['日常', '未分类', '婚礼'], '按相册里最新一条时间倒序');

    const paths = index.items.map((i) => i.path).sort();
    assert.ok(!paths.some((p) => p.includes('thumbs')), '缩略图目录不该进来');
    assert.ok(!paths.some((p) => p.startsWith('.')), '隐藏目录不该进来');
    assert.ok(!paths.some((p) => p.includes('新建文件夹')), '.galleryignore 规则要生效');
    assert.ok(!paths.some((p) => p.startsWith('~$')));
    assert.ok(!paths.some((p) => p.endsWith('.txt')), '非图片视频扩展名不收');

    const byPath = new Map(index.items.map((i) => [i.path, i]));
    assert.equal(byPath.get('婚礼/2019-10-06 仪式.png').date, '2019-10-06');
    assert.equal(byPath.get('婚礼/0812400607203bd81893772.png').dateSource, 'mtime', '哈希名不能被当成日期');
    assert.equal(byPath.get('日常/2019-13-45 假日期.png').date.slice(0, 4), '2017', '非法月份退回修改时间');
    assert.equal(byPath.get('IMG_rootless.png').album, '未分类', '散在根目录的照片要有归属');
    // 主序是时间倒序，同一天再按路径，保证「加载更多」不会漏项或重复
    const times = index.items.map((i) => i.time);
    assert.deepEqual(times, [...times].sort((a, b) => b - a), '索引必须按时间倒序');
  } finally {
    await svc.close();
  }
});

test('/healthz 报出家底，供开机自启与运维脚本判断', async () => {
  const svc = await startTestServer();
  try {
    const res = await get(svc.base, '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items, 9);
    assert.equal(res.body.albums, 3);
    assert.equal(res.body.cacheWritable, true);
    assert.equal(res.body.ffmpeg, false, '没 detectFfmpeg 之前不能谎报能动图');
    assert.ok(Number.isInteger(res.body.uptimeSec));
  } finally {
    await svc.close();
  }
});

test('站点信息接口给得出标题、统计与相册概览', async () => {
  const svc = await startTestServer();
  try {
    const res = await get(svc.base, '/api/site');
    assert.equal(res.status, 200);
    assert.equal(res.body.title, svc.config.siteTitle);
    assert.equal(res.body.stats.total, 9);
    assert.equal(res.body.albums.length, 3);
    assert.equal(res.body.featured, false, '没有 featured.txt 时不要假装精选生效');
    assert.equal(res.body.anim, false);
    // 只报目录名，不把本机绝对路径交给浏览器
    assert.equal(res.body.rootName, path.basename(svc.media.root));
    const wedding = res.body.albums.find((a) => a.name === '婚礼');
    assert.equal(wedding.count, 4);
    assert.ok(wedding.cover.url.startsWith('/media/'), '封面要带前端能直接用的 URL');
    assert.ok(wedding.cover.thumb.includes('/thumb?p='));
  } finally {
    await svc.close();
  }
});

test('背景音乐接口：列出 bgm 整夹、洗好展示名、滤掉非音频', async () => {
  const svc = await startTestServer();
  try {
    const res = await get(svc.base, '/api/bgm');
    assert.equal(res.status, 200);
    assert.equal(res.body.folder, svc.config.bgmFolder);
    assert.equal(typeof res.body.defaultVolume, 'number');
    // 两个 .mp3 收下；notes.txt（非音频）与 .hidden.mp3（点开头）都被拦下
    assert.equal(res.body.count, 2);
    assert.deepEqual(res.body.tracks.map((t) => t.name), ['First-Song.mp3', 'Second_Theme.mp3'], '按名排序');
    // 展示名：连字符/下划线都换成空格，去掉扩展名
    assert.deepEqual(res.body.tracks.map((t) => t.title), ['First Song', 'Second Theme']);
    for (const t of res.body.tracks) {
      assert.ok(t.url.startsWith('/media/'), '与相册同源直出');
      assert.ok(decodeURIComponent(t.url).includes(`${svc.config.bgmFolder}/`));
      assert.ok(Number.isInteger(t.size) && t.size >= 0);
    }

    // 音频能经 /media 直取，且支持 Range（长音频拖进度条要靠它）
    const first = res.body.tracks[0];
    const full = await fetch(`${svc.base}${first.url}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const ranged = await fetch(`${svc.base}${first.url}`, { headers: { range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206, '带 Range 应回 206，音频才能边下边播');
  } finally {
    await svc.close();
  }
});

test('背景音乐接口：没建 bgm 目录时优雅退化成空表，不报错', async () => {
  const svc = await startTestServer();
  try {
    // 整个删掉素材根下那层 bgm，模拟「这台机器没准备音乐」
    await require('fs/promises').rm(path.join(svc.media.root, svc.config.bgmFolder), { recursive: true, force: true });
    const res = await get(svc.base, '/api/bgm');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.tracks, [], '前端据此隐藏播放控件');
  } finally {
    await svc.close();
  }
});

test('查询接口：过滤、排序、分页都自洽', async () => {
  const svc = await startTestServer();
  try {
    const all = await get(svc.base, '/api/media');
    assert.equal(all.body.total, 9);
    assert.equal(all.body.items.length, 9);

    const videos = await get(svc.base, '/api/media?kind=video');
    assert.equal(videos.body.total, 1);
    assert.equal(videos.body.items[0].kind, 'video');

    const album = await get(svc.base, '/api/media?album=婚礼&kind=photo');
    assert.equal(album.body.total, 3);

    const year = await get(svc.base, '/api/media?year=2020');
    assert.deepEqual(year.body.items.map((i) => i.date).sort(), ['2020-01-01', '2020-10-10']);

    const month = await get(svc.base, '/api/media?month=2019-10');
    assert.equal(month.body.total, 1);

    const q = await get(svc.base, '/api/media?q=仪式');
    assert.equal(q.body.total, 1, '关键词能命中中文文件名');
    assert.equal(q.body.items[0].name, '2019-10-06 仪式');

    const oldest = await get(svc.base, '/api/media?sort=oldest');
    assert.equal(oldest.body.items[0].date, '2017-01-01');
    const byName = await get(svc.base, '/api/media?sort=name');
    assert.ok(byName.body.items.length === 9);

    // 分页：两页合起来既不重复也不漏
    const p1 = await get(svc.base, '/api/media?pageSize=4&page=1');
    const p2 = await get(svc.base, '/api/media?pageSize=4&page=2');
    const p3 = await get(svc.base, '/api/media?pageSize=4&page=3');
    assert.equal(p1.body.pages, 3);
    assert.equal(p1.body.hasMore, true);
    assert.equal(p3.body.hasMore, false);
    const merged = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((i) => i.path);
    assert.equal(new Set(merged).size, 9, '翻页不能有重复');

    // 越界的页码给空数组而不是 500
    const far = await get(svc.base, '/api/media?page=999');
    assert.equal(far.status, 200);
    assert.deepEqual(far.body.items, []);
  } finally {
    await svc.close();
  }
});

test('一次请求不能被拉走整库：pageSize 有硬上限', async () => {
  const svc = await startTestServer();
  try {
    const res = await get(svc.base, '/api/media?pageSize=99999');
    assert.equal(res.status, 200);
    assert.equal(res.body.pageSize, svc.config.maxPageSize);
    const bad = await get(svc.base, '/api/media?pageSize=0&page=-5');
    assert.equal(bad.body.page, 1, '页码再离谱也夹回第一页');
    assert.equal(bad.body.pageSize, svc.config.pageSize);
  } finally {
    await svc.close();
  }
});

test('时间线接口给到年月与封面', async () => {
  const svc = await startTestServer();
  try {
    const res = await get(svc.base, '/api/timeline');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.months.map((m) => m.month),
      ['2024-01', '2023-02', '2022-07', '2021-05', '2020-10', '2020-01', '2019-10', '2018-03', '2017-01']);
    assert.equal(res.body.months[0].count, 1);
    assert.ok(res.body.months.every((m) => m.cover && m.cover.url.startsWith('/media/')));
    assert.deepEqual(res.body.years.map((y) => y.year),
      ['2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017']);
    const y2020 = res.body.years.find((y) => y.year === '2020');
    assert.equal(y2020.count, 2);
    assert.deepEqual(y2020.months, ['2020-10', '2020-01']);
  } finally {
    await svc.close();
  }
});

test('精选清单：没有 featured.txt 就退化成最新照片，有了就按行序', async () => {
  const plain = await startTestServer();
  try {
    const res = await get(plain.base, '/api/featured');
    assert.equal(res.body.rules, 0);
    assert.equal(res.body.items[0].date, '2024-01-02', '退化时按时间倒序给最新的');
  } finally {
    await plain.close();
  }

  // 注释与空行要被忽略；规则按「命中即取第一张」；不够数时用最新照片补齐
  const svc = await startTestServer({
    featured: ['# 一行一条\n\n婚礼/2019-10-06 仪式.png  # 行内注释\n不存在的目录\n午饭\n']
  });
  try {
    const res = await get(svc.base, '/api/featured?limit=4');
    assert.equal(res.body.rules, 3);
    const paths = res.body.items.map((i) => i.path);
    assert.deepEqual(paths.slice(0, 2), ['婚礼/2019-10-06 仪式.png', '日常/午饭.png'], '按行序，命不中的跳过');
    assert.equal(new Set(paths).size, 4, '补齐后也不能重复');
    assert.equal(paths.slice(2).every((p) => !paths.slice(0, 2).includes(p)), true);
  } finally {
    await svc.close();
  }
});

test('置顶相册：@ 开头的行只管顺序，不被当成精选照片，名字写错也不报错', async () => {
  const svc = await startTestServer({
    featured: ['@婚礼', '@不存在的相册', '婚礼/2019-10-06 仪式.png', '@婚礼  # 重复的一行只算一次'].join('\n')
  });
  try {
    const res = await get(svc.base, '/api/site');
    assert.equal(res.status, 200);
    // 原样回传写进去的名字（含不存在的），前端只按它排序，名字错了自然排不上，不默默吞掉
    assert.deepEqual(res.body.pinned, ['婚礼', '不存在的相册'], '重复的 @婚礼 只算一次');
    // 婚礼本来最新一张是 2020-10-10，排在日常、未分类后面；置顶后被提到横幅位
    assert.deepEqual(res.body.albums.map((a) => a.name), ['婚礼', '日常', '未分类']);
    // 只有真正的照片规则才计数，否则 @婚礼 会被当成一段路径去匹配而白占一个位置
    const feat = await get(svc.base, '/api/featured');
    assert.equal(feat.body.rules, 1);
    assert.equal(feat.body.items[0].path, '婚礼/2019-10-06 仪式.png');
  } finally {
    await svc.close();
  }
});

test('相册封面：@相册名=规则 指定用哪张，命不中退回自动挑的那张', async () => {
  const svc = await startTestServer({
    featured: ['@婚礼=婚礼/2019-10-06 仪式.png', '@日常=午饭', '@不存在=根本不存在的东西'].join('\n')
  });
  try {
    const res = await get(svc.base, '/api/site');
    assert.equal(res.status, 200);
    const byName = new Map(res.body.albums.map((a) => [a.name, a]));
    // 不指定时婚礼的封面是最新那张（摆拍/mmexport…）；指定了就能挑相册里任意一张
    assert.equal(byName.get('婚礼').cover.path, '婚礼/2019-10-06 仪式.png');
    // 规则只写文件名的一小段也算命中
    assert.equal(byName.get('日常').cover.path, '日常/午饭.png');
    // 没指定的相册走自动挑的那张，不受别人那行影响
    assert.equal(byName.get('未分类').cover.path, 'IMG_rootless.png');
    // 指定封面顺带置顶（不然在已有的 @婚礼 行后面加个 =… 会把置顶弄丢）
    assert.deepEqual(res.body.albums.map((a) => a.name), ['婚礼', '日常', '未分类']);
    assert.deepEqual(res.body.covers, ['婚礼', '日常', '不存在'], '哪几本是人指定的，回传便于排查');
    // 等号后面那段不算精选规则，否则首页拼贴会被它多占一个位置
    const feat = await get(svc.base, '/api/featured');
    assert.equal(feat.body.rules, 0);
    // 规则落空时得有人说一句：不然「改了没反应」只能猜是哪一行写错了。
    // 这里只有 @不存在 那行点不到东西（夹具里没有这本相册），婚礼和日常都该静默
    const problems = svc.app.__internals.auditFeaturedRules();
    assert.equal(problems.length, 1, `只该有 @不存在 那行落空：${problems.join(' | ')}`);
    assert.ok(problems[0].includes('不存在'), problems[0]);
  } finally {
    await svc.close();
  }
});

test('缩略图：照片出 webp 并可以长期缓存', async () => {
  const svc = await startTestServer();
  try {
    const url = `/thumb?p=${encodeURIComponent('婚礼/2019-10-06 仪式.png')}&w=200`;
    const first = await get(svc.base, url);
    assert.equal(first.status, 200);
    assert.equal(first.type, 'image/webp');
    assert.match(first.headers.get('cache-control'), /max-age=31536000/);
    const again = await fetch(`${svc.base}${url}`);
    const bytesA = Buffer.from(await again.arrayBuffer());
    const bytesB = Buffer.from(await (await fetch(`${svc.base}${url}`)).arrayBuffer());
    assert.deepEqual(bytesA, bytesB, '缓存必须返回同一张图');

    const wide = await get(svc.base, `/thumb?p=${encodeURIComponent('婚礼/2019-10-06 仪式.png')}&w=99999`);
    assert.equal(wide.status, 200, '超宽请求要被夹住而不是报错');
  } finally {
    await svc.close();
  }
});

test('缩略图：视频给占位封面，坏图退回原图，都不该 500', async () => {
  const svc = await startTestServer();
  try {
    const poster = await get(svc.base, `/thumb?p=${encodeURIComponent('婚礼/video.mp4')}&w=480`);
    assert.equal(poster.status, 200);
    assert.equal(poster.type, 'image/svg+xml', '没有 ffmpeg 时给 SVG 播放器封面');
    assert.match(poster.body, /<svg/);

    const broken = await fetch(`${svc.base}/thumb?p=${encodeURIComponent('日常/坏图.png')}&w=480`,
      { redirect: 'manual' });
    assert.equal(broken.status, 307, '解不了的图重定向到原图，别留白');
    assert.equal(decodeURIComponent(broken.headers.get('location') || ''), '/media/日常/坏图.png');
  } finally {
    await svc.close();
  }
});

test('路径越权：什么花样都不能读到素材目录之外的文件', async () => {
  const svc = await startTestServer();
  const secret = JSON.stringify({ marker: 'outside-the-root' });
  await require('fs/promises').writeFile(svc.media.file('../gallery-secret.json'), secret, 'utf8');
  try {
    const attempts = [
      '/thumb?p=../package.json',
      '/thumb?p=..%2f..%2fpackage.json',
      `/thumb?p=${encodeURIComponent(svc.config.featuredFile)}`,
      '/thumb?p=C:/Windows/win.ini',
      '/thumb?p=',
      '/thumb'
    ];
    for (const url of attempts) {
      const res = await get(svc.base, url);
      assert.ok(res.status === 400 || res.status === 404, `${url} 不该被放行，却是 ${res.status}`);
    }

    const media = [
      '/media/../gallery-secret.json',
      '/media/..%2fgallery-secret.json',
      '/media/%2e%2e%2fgallery-secret.json',
      '/media/%2e%2e%5cgallery-secret.json',
      `/media/${encodeURIComponent('../gallery-secret.json')}`,
      '/media/..\\..\\Windows\\win.ini'
    ];
    for (const url of media) {
      const res = await fetch(`${svc.base}${url}`);
      const text = res.ok ? await res.text() : '';
      assert.ok(!text.includes('outside-the-root'), `${url} 泄漏了根目录之外的文件`);
    }

    const anim = await get(svc.base, '/anim/..%2f..%2fpackage.json');
    assert.equal(anim.status, 400, '动图只接受十六进制文件名');
    const missing = await get(svc.base, `/anim/${'0'.repeat(40)}.webp`);
    assert.equal(missing.status, 404);

    const secretApi = await get(svc.base, `/api/anim?p=${encodeURIComponent('../gallery-secret.json')}`);
    assert.equal(secretApi.status, 404);
  } finally {
    await svc.close();
  }
});

test('safeResolve 的判定表', async () => {
  const svc = await startTestServer();
  const { safeResolve } = svc.app.__internals;
  try {
    const root = path.resolve(svc.media.root);
    assert.equal(safeResolve('婚礼/a.jpg'), path.join(root, '婚礼', 'a.jpg'));
    assert.equal(safeResolve('%E5%A9%9A%E7%A4%BC%2Fa.jpg'), path.join(root, '婚礼', 'a.jpg'), '允许一次编码');
    assert.equal(safeResolve('a\\b.jpg'), path.join(root, 'a', 'b.jpg'), '反斜杠也要收下');
    assert.equal(safeResolve('/婚礼/a.jpg'), path.join(root, '婚礼', 'a.jpg'), '开头的斜杠是装饰');
    assert.equal(safeResolve('../a.jpg'), null);
    assert.equal(safeResolve('..\\a.jpg'), null);
    assert.equal(safeResolve('a/../../b.jpg'), null, '绕一圈出来也不行');
    assert.equal(safeResolve(path.resolve(svc.media.root, '..', 'elsewhere.jpg')), null, '绝对路径必须在根内');
    assert.equal(safeResolve('a%00.jpg'), null, '空字节直接拒');
    assert.equal(safeResolve('%ZZ'), null, '解不开的编码不要抛异常');
    assert.equal(safeResolve(''), null);
    assert.equal(safeResolve('   '), null);
    assert.equal(safeResolve(undefined), null);
    // 邻居目录：f:\照片 不能顺手放行 f:\照片其他东西
    assert.equal(safeResolve(path.resolve(svc.media.root + '-sibling', 'x.jpg')), null);
  } finally {
    await svc.close();
  }
});

test('动图与视频信息接口：只服务视频，没有 ffmpeg 就说清楚', async () => {
  const svc = await startTestServer();
  try {
    const notVideo = await get(svc.base, `/api/anim?p=${encodeURIComponent('日常/午饭.png')}`);
    assert.equal(notVideo.status, 404);

    const noFfmpeg = await get(svc.base, `/api/anim?p=${encodeURIComponent('婚礼/video.mp4')}`);
    assert.equal(noFfmpeg.status, 503, '做不了就要说做不了，不要挂 5 秒再 500');
    assert.match(noFfmpeg.body.message, /ffmpeg/);

    const info = await get(svc.base, `/api/video-info?p=${encodeURIComponent('婚礼/video.mp4')}`);
    assert.equal(info.status, 200);
    assert.equal(info.body.duration, null, '探不到时长就给 null，让前端不显示角标');
    const infoOnPhoto = await get(svc.base, `/api/video-info?p=${encodeURIComponent('日常/午饭.png')}`);
    assert.equal(infoOnPhoto.status, 404);
  } finally {
    await svc.close();
  }
});

test('响应头：接口不缓存，图片缓存一年，页面走协商', async () => {
  const svc = await startTestServer();
  try {
    const api = await get(svc.base, '/api/site');
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.equal(api.headers.get('content-security-policy').includes("default-src 'self'"), true);
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(api.headers.get('referrer-policy'), 'same-origin');
    assert.ok(!api.headers.get('server'), '不告诉别人这是 Express');

    const page = await get(svc.base, '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-cache', '改版后刷新就要看到新的');
    const etag = page.headers.get('etag');
    assert.ok(etag, '页面要有 ETag，304 才有得谈');
    // 协商缓存必须用裸 http 验：fetch 不让我们自己设 If-None-Match
    const conditional = await raw(svc.base, '/', { 'if-none-match': etag });
    assert.equal(conditional.status, 304);
    const modified = await raw(svc.base, '/', { 'if-none-match': 'W/"0000-0000"' });
    assert.equal(modified.status, 200, 'ETag 对不上时要照旧给图');

    const client = await get(svc.base, '/app.js');
    assert.equal(client.headers.get('cache-control'), 'no-cache');
  } finally {
    await svc.close();
  }
});

test('单页路由与接口 404 各归各', async () => {
  const svc = await startTestServer();
  try {
    for (const url of ['/albums', '/timeline', '/films', '/about', '/albums/婚礼']) {
      const res = await get(svc.base, url);
      assert.equal(res.status, 200, `${url} 应该出页面`);
      assert.match(res.type, /text\/html/);
    }
    const api404 = await get(svc.base, '/api/nope');
    assert.equal(api404.status, 404);
    assert.equal(api404.type.includes('json'), true, '接口 404 要给 JSON，别给一堆 HTML');
    assert.match(api404.body.message, /接口不存在/);
  } finally {
    await svc.close();
  }
});

test('原图与视频支持 Range，几百 MB 的视频才能拖进度条', async () => {
  const svc = await startTestServer();
  try {
    const full = await get(svc.base, `/media/${encodeURIComponent('婚礼/2019-10-06 仪式.png')}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');

    const ranged = await fetch(`${svc.base}/media/${encodeURIComponent('婚礼/2019-10-06 仪式.png')}`,
      { headers: { range: 'bytes=0-1' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.arrayBuffer().then((b) => b.byteLength), 2);

    const missing = await fetch(`${svc.base}/media/${encodeURIComponent('婚礼/没有这个文件.jpg')}`);
    // 静态目录找不到就往下漏给单页兜底，绝不把本地路径拼出去报错
    assert.equal(missing.status, 200);
    assert.match(missing.headers.get('content-type') || '', /text\/html/);

    const refresh = await get(svc.base, '/api/refresh', { method: 'POST' });
    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.ok, true);
    // 重扫是后台跑的，等它写完缓存再拆目录，不然会留一地临时文件
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await svc.close();
  }
});

test('PWA 资源齐备：manifest 解得开，里面写的文件都得存在', async () => {
  const svc = await startTestServer();
  try {
    const manifest = await fetch(`${svc.base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    // 类型不对浏览器直接不看这个 manifest，装不上比没写更坑
    assert.match(manifest.headers.get('content-type') || '', /manifest\+json|application\/json/);
    const mf = JSON.parse(await manifest.text());
    assert.ok(mf.name && mf.short_name && mf.start_url);
    assert.ok(mf.theme_color && mf.background_color, '状态栏与启动屏颜色得给，不然开场闪白');
    assert.equal(mf.display, 'standalone');
    assert.ok(mf.icons.some((i) => i.purpose === 'maskable'), 'Android 圆/方遮罩下不能露白边');

    for (const icon of mf.icons) {
      const res = await fetch(`${svc.base}${icon.src}`);
      assert.equal(res.status, 200, `${icon.src} 写进了 manifest 就得拿得到`);
    }

    const sw = await fetch(`${svc.base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type') || '', /javascript/);
  } finally {
    await svc.close();
  }
});
