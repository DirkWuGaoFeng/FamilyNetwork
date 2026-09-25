/**
 * 索引逻辑：日期推断、排除规则、相册/时间线汇总、查询分页
 *
 * 这一层没有数据库，整个站看到什么全凭这里算出来的索引，所以纯函数必须钉住。
 * 尤其是 inferDate —— 它一旦判错，就会凭空多出「1995 年」这种没人拍过的月份，
 * 而这类错误在页面上看不出异常，只有翻到那个月才会疑惑。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const scan = require('../server/scan');
const { inferDate, isIgnored, kindOf, buildAlbums, buildTimeline, pickCover, setIgnoreRules, isoDay } = scan.internals;

/** 一个毫秒时间戳，省得每处写 Date.UTC */
const at = (...args) => Date.UTC(...args);

test('inferDate 认得文件名里的几种日期写法', () => {
  const mtime = at(2000, 0, 1);
  for (const name of ['20191006.jpg', '2019-10-06 仪式.jpg', '2019_10_06.jpg', '2019.10.06.jpg', 'IMG_20191006_201430.jpg']) {
    const got = inferDate(name, [], mtime);
    assert.equal(got.date, '2019-10-06', `${name} 应该被认成 2019-10-06`);
    assert.equal(got.source, 'filename');
  }
});

test('inferDate 认得微信与快手导出名里的毫秒时间戳', () => {
  // 1514953916330 → 2018-01-03（本机时区），只断言年份与来源，避免测试绑死时区
  const wx = inferDate('wx_camera_1514953916330.jpg', [], at(2000, 0, 1));
  assert.equal(wx.source, 'filename');
  assert.match(wx.date, /^2018-01-0/);
  const mm = inferDate('mmexport1602316522535.png', [], at(2000, 0, 1));
  assert.equal(mm.source, 'filename');
  assert.match(mm.date, /^2020-10-1/);
});

test('inferDate 不被长得像日期的哈希名骗到', () => {
  const mtime = at(2018, 2, 4, 5, 6, 7);
  // 快手文件名：开头一段数字看着像 20060720，但它不是日期
  const kuaishou = inferDate('0812400607203bd81893772.jpg', [], mtime);
  assert.equal(kuaishou.source, 'mtime');
  assert.equal(kuaishou.date, isoDay(mtime));

  // 非法月份/日期退回修改时间
  assert.equal(inferDate('2019-13-45.jpg', [], mtime).source, 'mtime');
  assert.equal(inferDate('2019-10-32.jpg', [], mtime).source, 'mtime');
  // 1990 年以前的多是瞎写，不如不用
  assert.equal(inferDate('19001006.jpg', [], mtime).source, 'mtime');
  // 未来的日期同样不信
  assert.equal(inferDate('20991006.jpg', [], mtime).source, 'mtime');
  // 数字串两侧还有数字时不算日期：081240060720 中间藏着 20060720
  assert.equal(inferDate('id20191006001.jpg', [], mtime).source, 'mtime');
});

test('inferDate 会从上层目录名里找日期，就近优先', () => {
  const mtime = at(2000, 0, 1);
  const got = inferDate('DSC0001.JPG', ['20210520 生日', '婚礼'], mtime);
  assert.equal(got.date, '2021-05-20');
  assert.equal(got.source, 'filename');
  // 文件名自己带日期时，不被目录名带走
  assert.equal(inferDate('2019-10-06.jpg', ['20210520'], mtime).date, '2019-10-06');
});

test('kindOf 只认配置的扩展名，且大小写无关', () => {
  assert.equal(kindOf('a.jpg'), 'photo');
  assert.equal(kindOf('a.JPG'), 'photo');
  assert.equal(kindOf('a.jpeg'), 'photo');
  assert.equal(kindOf('a.png'), 'photo');
  assert.equal(kindOf('a.mp4'), 'video');
  assert.equal(kindOf('a.MOV'), 'video');
  assert.equal(kindOf('a.txt'), null);
  assert.equal(kindOf('a.zip'), null);
  assert.equal(kindOf('无扩展名'), null);
});

test('isIgnored 挡掉系统垃圾目录与 .galleryignore 规则', () => {
  setIgnoreRules(['不要', '新建文件夹', '婚纱照/备选']);

  assert.ok(isIgnored('.DS_Store', '.DS_Store'), '点开头一律不上站');
  assert.ok(isIgnored('~$draft.jpg', '~$draft.jpg'), 'Office 临时文件');
  assert.ok(isIgnored('thumbs/a.jpg', 'thumbs'), '系统缩略图目录');
  assert.ok(isIgnored('THUMBS', 'THUMBS'), '目录名大小写无关');
  assert.ok(isIgnored('a/@ea-doc', '@ea-doc'), '群晖缩略图目录');

  // 不带斜杠的规则按任一层目录名匹配
  assert.ok(isIgnored('婚礼/不要/2019.jpg', '2019.jpg'), '命中「不要」目录');
  assert.ok(isIgnored('婚纱照/新建文件夹/a.jpg', 'a.jpg'), '命中「新建文件夹」');
  // 带斜杠的规则要求整段路径
  assert.ok(isIgnored('婚纱照/备选/a.jpg', 'a.jpg'));
  assert.ok(!isIgnored('日常/备选/a.jpg', 'a.jpg'), '「婚纱照/备选」不该波及别处');
  // 正常内容放行
  assert.ok(!isIgnored('婚礼/2019-10-06.jpg', '2019-10-06.jpg'));
});

/** 造一条索引条目，只填跟汇总逻辑有关的字段 */
function item(overrides) {
  return {
    path: 'x.jpg',
    name: 'x',
    fileName: 'x.jpg',
    kind: 'photo',
    album: '相册',
    folder: '相册',
    sub: '',
    size: 500 * 1024,
    date: '2020-01-01',
    time: at(2020, 0, 1),
    ...overrides
  };
}

test('buildAlbums 按顶层目录归组，封面挑新且不太小的照片', () => {
  const items = [
    item({ path: '婚礼/a.jpg', album: '婚礼', time: at(2021, 5, 1), date: '2021-06-01', size: 4 * 1024 * 1024 }),
    // 又新又小：多半是聊天截图，不该当封面
    item({ path: '婚礼/shot.png', album: '婚礼', time: at(2021, 6, 1), date: '2021-07-01', size: 40 * 1024 }),
    item({ path: '婚礼/v.mp4', album: '婚礼', kind: 'video', time: at(2021, 7, 1), date: '2021-08-01' }),
    item({ path: '日常/b.jpg', album: '日常', time: at(2019, 0, 1), date: '2019-01-01' }),
    item({ path: 'root.jpg', album: '未分类', time: at(2020, 0, 1), date: '2020-01-01' })
  ];
  const albums = buildAlbums(items);

  assert.deepEqual(albums.map((a) => a.name), ['婚礼', '未分类', '日常'], '最近的相册排前面');
  const wedding = albums[0];
  assert.equal(wedding.count, 3);
  assert.equal(wedding.photos, 2);
  assert.equal(wedding.videos, 1);
  assert.equal(wedding.cover.path, '婚礼/a.jpg', '封面要跳过过小的截图');
  assert.deepEqual(wedding.years, ['2021']);
  assert.equal(albums[1].name, '未分类');
});

test('buildAlbums 会把子目录汇总成分册，并按最近时间排序', () => {
  const albums = buildAlbums([
    item({ album: '婚礼', folder: '婚礼/摆拍', sub: '摆拍', time: at(2019, 0, 1), date: '2019-01-01' }),
    item({ album: '婚礼', folder: '婚礼/仪式', sub: '仪式', time: at(2021, 0, 1), date: '2021-01-01' }),
    item({ album: '婚礼', folder: '婚礼', sub: '', time: at(2020, 0, 1), date: '2020-01-01' })
  ]);
  assert.equal(albums[0].folderCount, 3);
  assert.deepEqual(albums[0].folders.map((f) => f.name), ['仪式', '全部', '摆拍']);
});

test('buildTimeline 按月倒序汇总，封面优先照片', () => {
  const items = [
    item({ path: 'v.mp4', kind: 'video', date: '2020-03-01', time: at(2020, 2, 1) }),
    item({ path: 'a.jpg', date: '2020-03-05', time: at(2020, 2, 5) }),
    item({ path: 'b.jpg', date: '2021-01-09', time: at(2021, 0, 9) })
  ];
  const { months, years } = buildTimeline(items);

  assert.deepEqual(months.map((m) => m.month), ['2021-01', '2020-03']);
  assert.equal(months[1].count, 2);
  assert.equal(months[1].photos, 1);
  assert.equal(months[1].videos, 1);
  assert.equal(months[1].cover, 'a.jpg', '同一月里有照片就不该用视频当封面');
  assert.deepEqual(years.map((y) => `${y.year}:${y.count}`), ['2021:1', '2020:2']);
});

test('pickCover 一张照片都没有时才用视频兜底', () => {
  const video = item({ path: 'v.mp4', kind: 'video' });
  assert.equal(pickCover([video]).path, 'v.mp4');
  assert.equal(pickCover([]), null);
  const small = item({ path: 'tiny.jpg', size: 10 * 1024 });
  const big = item({ path: 'big.jpg', size: 3 * 1024 * 1024 });
  // 传入顺序即时间倒序：最新的太小，就用下一张够大的
  assert.equal(pickCover([small, big]).path, 'big.jpg');
});
