# 我们的家 · 家庭影像档案

把电脑里那一堆照片和视频，直接变成家里人都能打开的网页。

- **零数据库**：素材目录本身就是唯一数据源，删掉缓存也能重新扫出来
- **零构建**：前端就是 `public/` 下的几个文件，浏览器直接跑，改完刷新就生效
- **无登录**：连上家里 WiFi 就能看（所以：**不要把端口映射到公网**）
- **只读**：程序只会往 `.cache/` 里写缩略图，一张照片都不会动、不会删

---

## 30 秒跑起来

前提：装好 [Node.js 20 或更新](https://nodejs.org/)（命令行敲 `node -v` 能看到版本号）。

```powershell
npm install
Copy-Item .env.example .env   # 然后打开 .env，把 MEDIA_ROOT 改成你的照片目录
npm start
```

看到这样就成了：

```
  我们的家 · 家庭相册已就绪
  本机访问   http://localhost:8123
  手机/平板  http://192.168.1.20:8123
  素材目录   D:\FamilyPhotos
  索引       3714 个素材 / 6 个相册
```

第一次启动会完整扫一遍素材目录，几千个文件大概一两分钟，之后每次都用缓存，秒开。
没填 `MEDIA_ROOT` 就不会启动，它会直接告诉你是哪一项缺——照片在哪个盘只可能你自己知道，
代码里写死一个默认值只会在别人机器上扫出一个空目录。

**以后想换目录**：改 `.env` 里那一行就行，不用动代码。全部可选项见下面的[配置表](#配置表)。

---

## 手机上怎么看

1. 手机连上和电脑**同一个 WiFi**
2. 浏览器输入启动时打印的那个 `http://192.168.x.x:8123`
3. 想脱离浏览器：
   - **iPhone**：Safari 分享按钮 → 「添加到主屏幕」
   - **安卓 / 鸿蒙**：Chrome 菜单 → 「安装应用」或「添加到主屏幕」

装完有独立的图标（我们自己的「屋顶 + 相框」）、全屏无地址栏、状态栏也是米白色。
手机上看图走的是缩略图与中等尺寸预览，不会去拉几十 MB 的原图。

> 关于离线：Service Worker 只在 **https 或 localhost** 下允许注册，局域网 IP 用
> 的是 http，所以浏览器不会装它——这是规范限制，不是 bug。「添加到主屏幕」
> 不依赖它，照样能用。想要离线缓存就把站点挂到 https 下（见
> [docs/operations.md](docs/operations.md)）。

---

## 页面能干什么

| 页面 | 地址 | 内容 |
| --- | --- | --- |
| 家 | `#/` | 精选拼贴、数字总览、按年份横滑、通栏大图 |
| 相册 | `#/albums` | 每个顶层文件夹一本相册，可钻到子文件夹 |
| 时间 | `#/timeline` | 按年月倒序的瀑布流，右侧年份栏快速跳 |
| 影像 | `#/films` | 只看视频，卡片上有时长，可一键抽成循环动图 |
| 关于 | `#/about` | 这个站怎么运作的、目录、缓存、快捷键 |

- 按 `/` 打开搜索（搜文件名与文件夹名，输入四个数字会给你跳到那一年的入口）
- 灯箱里 `←` `→` 换张，`Esc` 关闭；**手机上直接左右滑换张、向下滑关掉**
- 右上角刷新按钮：刚拷了新照片，点一下重扫，不用重启服务

---

## 配置表

优先级：**命令行环境变量 > `.env` > 代码里的默认值**。改完 `.env` 要重启服务。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEDIA_ROOT` | 无，**必填** | 素材目录，唯一数据源，**只读** |
| `SITE_TITLE` / `SITE_SUBTITLE` | 我们的家 / 照片、视频和一起走过的日子 | 标题与副标题 |
| `PORT` | `8123` | 端口。被占用时启动器会直接告诉你怎么办 |
| `HOST` | `0.0.0.0` | `0.0.0.0` 家里其他设备可访问；`127.0.0.1` 只给自己看 |
| `CACHE_DIR` | `./.cache` | 索引 + 缩略图 + 动图，可随时整个删掉重建 |
| `RESCAN_MINUTES` | `10` | 索引超过这个年龄就后台重扫，请求不阻塞 |
| `THUMB_WIDTH` / `PREVIEW_WIDTH` | `480` / `1600` | 列表小图 / 灯箱中图的宽度 |
| `THUMB_QUALITY` | `78` | webp 质量，调高更清晰、更占磁盘也更慢 |
| `THUMB_CONCURRENCY` | `3` | 同时生成几张缩略图，机械盘不要超过 3 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 用 npm 装进来的 | 指向系统安装版也可以 |
| `FFMPEG_TIMEOUT` / `ANIM_TIMEOUT` | `25000` / `90000` | 抽一帧 / 做一张动图的等待上限（毫秒） |
| `PAGE_SIZE` / `MAX_PAGE_SIZE` | `120` / `500` | 每页条数 / 单页硬上限 |
| `FEATURED_FILE` / `FEATURED_LIMIT` | `./featured.txt` / `24` | 首页精选清单与数量上限 |
| `SLOW_REQUEST_MS` / `LOG_REQUESTS` | `1200` / 关 | 慢请求阈值；是否打印全部请求 |
| `DEBUG_PATHS` | 关 | 打开后接口会带绝对路径，**只在自己电脑上开** |

### 首页精选（featured.txt）

`featured.txt` **不入库**（里面全是你家人的名字和真实文件名，不该跟着仓库上公网），
仓库里的是模板：

```powershell
Copy-Item featured.example.txt featured.txt
```

一行一条规则，写完整路径或路径里的一段关键字都行，命中的**照片**按行序上首页：

```
宝宝/IMG_0102.jpg
全家福/2020婚礼/IMG_0001.jpg
```

三种规则（精选照片 / `@相册名` 置顶 / `@相册名=某张照片` 指定封面）的写法在
`featured.example.txt` 的注释里逐条写清楚了。一条都没命中（或者文件删了）也不会开天窗：
自动退回「每本相册封面」。改完点右上角刷新按钮即可生效，不用重启。

### 哪些文件不要进相册（.galleryignore）

仓库根目录的 `.galleryignore`，一行一条规则，命中即跳过。默认已经排掉了
`@eaDir`、`#recycle`、`thumbs`、`.thumbnails`、`~$` 临时文件、`.DS_Store`，
以及名字里带「不要」的文件夹。写法与 `#` 注释规则见文件里的说明。

---

## 常用命令

```powershell
npm start          # 前台启动（Ctrl+C 停），改代码调试时用
npm run dev        # 同上，带 --watch：改完 server 代码自动重启
npm run rescan     # 只扫一遍并打印统计，不起服务
npm run warm       # 把首页与相册封面的缩略图提前生成好（要先起服务，另开一个终端跑）
npm test           # 33 条测试，全部零依赖、跑独立临时目录，不碰真实照片
npm run icons      # 改完图标设计后重新导出各尺寸 png

pwsh scripts/gallery.ps1 start      # 后台启动，日志写 logs/
pwsh scripts/gallery.ps1 status     # 活着没有、多少素材、ffmpeg 可用否、自启状态
pwsh scripts/gallery.ps1 logs       # 最近 40 行日志
pwsh scripts/gallery.ps1 restart    # 重启
pwsh scripts/gallery.ps1 install    # 注册「登录后自动启动」
pwsh scripts/gallery.ps1 uninstall  # 取消自启
pwsh scripts/backup.ps1 -Destination "z:\相册备份"   # 备份配置与索引
```

---

## 目录结构

```
server/         Express 单进程
  index.js      启动器：环境自检、局域网地址、优雅退出
  app.js        路由、缓存策略、安全头、错误兜底
  scan.js       扫描素材目录 → 内存索引（.cache/index.json）
  thumbs.js     缩略图、视频抽帧、循环动图
  config.js     全部可调项都在这一个文件里
  env.js        读 .env
public/         前端：index.html（含全部样式）+ app.js + 图标 + manifest + sw.js
test/           零依赖测试（node:test）
scripts/        运维脚本：后台运行、自启、备份、图标导出
featured.example.txt 首页精选清单的模板（复制成 featured.txt 再改）
featured.txt    你自己的精选清单（不入库：里面是真实文件名与家人名字）
.galleryignore  扫描排除规则
.env            本地配置（不入库，从 .env.example 复制）
.cache/         索引与缩略图（不入库，可随便删）
```

---

## 出问题先看这里

| 现象 | 原因与办法 |
| --- | --- |
| 浏览器说打不开 | 服务没起来：`pwsh scripts/gallery.ps1 status`。端口被占用时启动器会直接说明，改 `PORT` 即可 |
| 手机连不上，电脑能连 | 多半是 Windows 防火墙拦了入站。[docs/operations.md](docs/operations.md) 里有一条命令放行 8123；也要确认手机和电脑在同一个 WiFi（很多路由器开了「AP 隔离」就互相连不通） |
| 电脑上 `localhost` 打不开，但局域网 IP 能开 | 回环地址上的这个端口被 WSL / Docker 的端口映射抢了（`Get-NetTCPConnection -LocalPort 8123 -State Listen` 看到 `wslrelay` 就是）。改 `PORT` 换一个没人用的端口 |
| 页面能开但图是裂的 | 素材目录被移动过或磁盘没挂载：`npm run rescan` 看它扫到多少文件 |
| 视频只有灰色占位封面 | ffmpeg 没就绪：`npm i ffmpeg-static` 后重启。启动日志里会明确说这件事 |
| 刚加的照片看不到 | 点右上角刷新，或 `npm run rescan`；索引默认 10 分钟也会自己重扫 |
| 首屏很慢 / 转圈久 | 缩略图是第一次见到才生成的，跑一次 `npm run warm` 提前烘好 |
| 改了 `.env` 没反应 | 必须重启服务；启动日志会列出「.env 已生效：PORT、MEDIA_ROOT…」，没列出来说明那一行写错了 |
| 磁盘越用越大 | 都是 `.cache/thumbs`，几 GB 正常。删掉整个 `.cache` 目录即可重建（会重新生成，慢一次） |
| 想确认服务健康 | `curl http://127.0.0.1:8123/healthz`，返回素材数量、ffmpeg 与缓存可写状态 |

---

## 安全边界（说清楚，别自欺）

- **没有登录、没有权限**：能连到这个端口的人 = 能看全部照片。只在家里 WiFi 用，
  **绝对不要**把端口做公网映射 / 内网穿透到外面。
- **只读**：程序不写、不改、不删素材目录里的任何文件；写操作只发生在 `CACHE_DIR`。
- **路径守门**：`/media`、`/thumb`、`/anim` 全部要过 `safeResolve`，一次解码后
  校验解析结果仍在素材目录内，`..`、编码绕过、空字节都会被打回 400。测试里有专门的越权用例。
- **响应头**：CSP（无内联脚本）、`nosniff`、`/api` 一律 `no-store`、缩略图 `immutable`。
- 想要真正对外可用：上 https + 加一层认证，这不在本项目的目标范围内。

---

## 更多文档

- [docs/usage.md](docs/usage.md) —— 给家里人看的使用说明（可以直接发群里）
- [docs/operations.md](docs/operations.md) —— 开机自启、备份、升级、防火墙、性能与故障排查

## 许可

[MIT](LICENSE)
