/**
 * 站点配置
 *
 * 全部可走环境变量或仓库根的 .env（把 .env.example 复制一份改改就行）。
 * 只有 MEDIA_ROOT 故意不给默认值：照片放在哪个盘、叫什么名字，每台机器
 * 都不一样，写死一个路径只会在别人电脑上扫出一个空目录（还会把这台机器的
 * 目录结构暴露到仓库里），不如启动时就吵一句。
 * 优先级：命令行环境变量 > .env > 这里的默认值。
 */
require('./env').load();

const fs = require('fs');
const path = require('path');

/**
 * 解析布尔型环境变量
 * @param {string|undefined} value 原始值
 * @param {boolean} fallback 默认值
 * @returns {boolean}
 */
function bool(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * 素材目录：唯一必填项。报错都说清楚下一步做什么，因为看到这条的人
 * 一般是刚拿到这份代码、还什么都不知道的你或者家人
 */
const mediaRoot = (process.env.MEDIA_ROOT || '').trim();
if (!mediaRoot) {
  throw new Error('还没告诉网站你的照片在哪：把 .env.example 复制为 .env，填好 MEDIA_ROOT=<素材目录> 再启动（或者直接用命令行变量）');
}
const root = path.resolve(mediaRoot);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  throw new Error(`MEDIA_ROOT 指向的目录不存在或不是一个文件夹：${root}`);
}

module.exports = {
  /** 素材所在的真实目录，站点的唯一数据源 */
  mediaRoot: root,

  /** 展示用名称：导航栏与页面标题 */
  siteTitle: process.env.SITE_TITLE || '我们的家',
  siteSubtitle: process.env.SITE_SUBTITLE || '照片、视频和一起走过的日子',

  /** 监听设置：默认开放给家里局域网，不要做端口映射到公网 */
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT) || 8123,

  /** 缓存目录：扫描索引 + 缩略图，删掉会自动重建，可以随时清 */
  cacheDir: path.resolve(process.env.CACHE_DIR || path.join(__dirname, '..', '.cache')),

  /** 索引多久算过期（过期后后台重新扫描，请求不阻塞） */
  rescanIntervalMs: Number(process.env.RESCAN_MINUTES || 10) * 60 * 1000,

  /** 缩略图尺寸：列表页与相册封面共用 */
  thumbWidth: Number(process.env.THUMB_WIDTH || 480),
  /** 灯箱里的中等尺寸，避免手机直连时拉原图 */
  previewWidth: Number(process.env.PREVIEW_WIDTH || 1600),
  thumbQuality: Number(process.env.THUMB_QUALITY || 78),
  /** 同时生成的缩略图数量，机械盘上不要开太大 */
  thumbConcurrency: Number(process.env.THUMB_CONCURRENCY || 3),

  /** 视频抽帧：默认用 npm 装进来的 ffmpeg；指向系统安装的也可以（PATH 里的ffmpeg名字即可） */
  ffmpegPath: process.env.FFMPEG_PATH || '',
  ffprobePath: process.env.FFPROBE_PATH || '',
  /** 单次抽帧最多等多久，超时就退回占位图，不让一个坏文件卡住整页 */
  ffmpegTimeoutMs: Number(process.env.FFMPEG_TIMEOUT || 25000),
  /** 循环动图要连续抽二十来帧，时间预算给宽一点 */
  animTimeoutMs: Number(process.env.ANIM_TIMEOUT || 90000),

  /** 允许出现在网站上的文件类型 */
  photoExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'],
  videoExtensions: ['.mp4', '.m4v', '.mov', '.webm', '.ogv'],

  /**
   * 背景音乐：素材根目录下这个文件夹里的音频整夹循环播放。
   * 它不在 photo/video 扩展名里，因而不会被当成相册内容污染索引。
   */
  bgmFolder: (process.env.BGM_FOLDER || 'bgm').replace(/^[/\\]+|[/\\]+$/g, '') || 'bgm',
  audioExtensions: (process.env.AUDIO_EXTENSIONS || '.mp3,.m4a,.aac,.ogg,.oga,.wav,.flac')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith('.')),
  /** 首次访问的默认音量（0~1），之后吃用户调过的 localStorage */
  bgmVolume: Math.min(1, Math.max(0, Number(process.env.BGM_VOLUME || 0.5) || 0.5)),

  /** 默认每页数量（前端「加载更多」每次追加同样数量） */
  pageSize: Number(process.env.PAGE_SIZE || 120),

  /** 首页精选数量上限 */
  featuredLimit: Number(process.env.FEATURED_LIMIT || 24),

  /** 首页精选清单：一行一条规则，见 featured.txt */
  featuredFile: path.resolve(process.env.FEATURED_FILE || path.join(__dirname, '..', 'featured.txt')),

  /** 是否在 /api 响应里带上绝对路径，仅调试用 */
  debugPaths: bool(process.env.DEBUG_PATHS, false),

  /** 请求日志：慢请求与出错请求一定会记；这个开关控制止于全部请求 */
  logAllRequests: bool(process.env.LOG_REQUESTS, false),
  /** 超过多少毫秒算慢请求 */
  slowRequestMs: Number(process.env.SLOW_REQUEST_MS || 1200),
  /** 单页最大条数（接口层硬上限 500，防着被人一次拉走整个索引） */
  maxPageSize: Number(process.env.MAX_PAGE_SIZE || 500)
};
