# 运维手册

面向「帮忙照看这台电脑」的人。使用层面的问题请看 [usage.md](usage.md)，
装不起来 / 连不上这类先看 [README 的故障排查表](../README.md#出问题先看这里)，
这里写得更细。

---

## 1. 它是怎么跑起来的

一个 Node 进程、一个端口，没有数据库、没有反向代理、没有构建步骤：

```
node server/index.js
  ├─ 读 .env（可选）
  ├─ 自检：素材目录可读？缓存目录可写？Node 版本够不够？
  ├─ 载入 .cache/index.json（没有就整扫一遍，几千文件约 1~2 分钟）
  ├─ 探测 ffmpeg（决定视频有没有真封面、能不能做动图）
  └─ 监听 0.0.0.0:8123
```

进程只往两个地方写：`CACHE_DIR`（默认 `.cache/`）和标准输出。
**素材目录永远只读**，所以任何时候直接 kill 进程都不会弄坏照片。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8123/healthz
# ok / uptimeSec / items / photos / videos / albums / generatedAt / ffmpeg / cacheWritable
```

`ffmpeg:false` → 视频只有占位封面；`cacheWritable:false` → 磁盘满或权限不对，
缩略图会现做现丢，页面会明显变慢。

### 背景音乐（`bgm/`）是现读的

素材根目录下的 `bgm/` 会被整夹循环播放（页面左下角那个播放坞）。它**不进上面那条启动流程**：
既不开机载入，也不生成缓存，所以很好排查。运维视角三件事：

- **放歌不用重启**：`/api/bgm` 每次请求现读目录，拷进去刷新页面就有；文件夹不存在或
  是空的，播放坞直接不显示，不影响其它功能
- **不落缓存**：音频走 `/media` 同源直出（带 Range，能边下边拖），不转码不缩略，
  `.cache` 不会因为它长大；备份时它和照片在同一个目录，一并备走即可
- **音量与开关存在每台设备自己的浏览器里**（localStorage），换浏览器 / 无痕模式
  就是回到默认，不用在服务器上找地方改

对应的 `.env` 可选项（不改也能跑，详见 `.env.example`）：`BGM_FOLDER`、`AUDIO_EXTENSIONS`、
`BGM_VOLUME`。默认**打开**：浏览器不允许无手势外放，所以首次进页碰一下屏幕就起播；
某台设备上一旦亲手按了暂停，下次进页就不再自动起（想恢复：点一下播放键）。
浏览器解不了的格式（比如 iOS 上的部分 flac）会自动跳下一首，整夹都失败才提示一句。

---

## 2. 后台运行与开机自启

### 用脚本（推荐）

```powershell
pwsh scripts/gallery.ps1 start      # 后台起，日志写 logs/gallery.*.log，PID 写 logs/gallery.pid
pwsh scripts/gallery.ps1 status     # 状态 + 素材数 + ffmpeg + 自启是否注册
pwsh scripts/gallery.ps1 restart    # 改了 .env 或代码之后
pwsh scripts/gallery.ps1 logs       # 最近 40 行
pwsh scripts/gallery.ps1 install    # 注册「登录后自动启动」
pwsh scripts/gallery.ps1 uninstall  # 取消
```

`install` 做的事很简单：在你的**「启动」文件夹**里放一个 `FamilyGallery.lnk`，
指向 `pwsh -NoProfile -WindowStyle Hidden -File scripts/gallery.ps1 start`。
不弹 UAC、不需要管理员，想去掉就把那个快捷方式删掉。

**限制**：只在**登录进桌面之后**生效。家里的电脑一般常年开机自动登录，够用。

### 想「开机就起、不登录也起」

需要管理员权限，用计划任务（`schtasks`）：

```powershell
# 以管理员身份打开 PowerShell
schtasks /Create /TN FamilyGallery /SC ONSTART /RU SYSTEM `
  /TR "powershell -NoProfile -WindowStyle Hidden -File \"E:\github\DirkProject\FamilyNetwork\scripts\gallery.ps1\" start" /RL LIMITED /F
```

**先确认一件事**：素材在 `F:` 这种映射盘 / 移动硬盘上时，SYSTEM 账户很可能读不到
（盘还没挂、权限不属于它）。这种情况就老老实实用登录自启，或者把素材放在
本机固定盘符上。跑完 `schtasks /Run /TN FamilyGallery`，再看
`pwsh scripts/gallery.ps1 status` 是不是绿的最稳妥。

### 别让电脑睡了

家用的「平衡」电源计划过十几分钟就把硬盘停转、机器睡眠，表现就是手机打不开。

```powershell
powercfg /change standby-timeout-ac 0     # 接电源时不睡眠
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0        # 不停硬盘
```

显示器可以关，主机别睡。

### 防火墙

只有这台电脑能访问、手机连不上，八成是入站被拦。放行一个端口：

```powershell
# 以管理员身份
New-NetFirewallRule -DisplayName "Family Gallery 8123" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8123 -Profile Private
```

`-Profile Private` 很关键：只在「专用网络」放行，别开 Public。
如果 Node 第一次启动时你点过「取消」，Windows 可能已经建了一条**阻止**规则，
`Get-NetFirewallRule -DisplayName "*Node*"` 看一眼，删掉重建。

另外：很多路由器开了「AP 隔离 / 客户端隔离」，WiFi 下设备之间本来就互相不通，
这跟本站无关，得进路由器改。

---

## 3. 日志

- 前台跑（`npm start`）：直接看终端
- 后台跑（脚本）：`logs/gallery.out.log`（启动横幅、扫描统计、慢请求、错误请求）
  与 `logs/gallery.err.log`（异常与告警）
- `logs/` 已在 `.gitignore` 里，随便删

默认只报**慢请求**（超过 `SLOW_REQUEST_MS`，1200 毫秒）和**出错请求**（>= 400），
所以日志不会变成访问流水。要临时看全部请求：`.env` 里 `LOG_REQUESTS=1` 后重启。

日志里出现大量 `/thumb` 慢请求是正常的——第一次见某张图就要现做，
跑一次 `npm run warm` 会好很多。

---

## 4. 备份与恢复

### 备份什么

| 内容 | 要不要备 | 说明 |
| --- | --- | --- |
| **照片、视频与 `bgm/` 音频本体** | **必须，但不归这个站管** | 站只读它们。请另用系统备份 / 网盘 / 移动硬盘，遵循 3-2-1 |
| `.env` | 要 | 里面是这台机器的路径与端口 |
| `featured.txt`、`.galleryignore` | 要 | 手写的规则，重不回来 |
| `.cache/index.json`、`.cache/durations.json` | 顺手备 | 重扫 3714 个文件要一两分钟，抽帧时长更久 |
| `.cache/thumbs`、`.cache/anim` | 不用 | 能重建，只是慢一次 |
| 代码 | 不用（在 git 里） | 前提是你 push 了 |

```powershell
pwsh scripts/backup.ps1                          # 备到 .\backups\config-时间戳\
pwsh scripts/backup.ps1 -Destination "z:\相册备份" -Keep 7
```

脚本会顺手把当时的 `healthz` 结果写成 `healthz.txt`，恢复时能对照。
建议每周跑一次（挂计划任务，或者干脆每次拷完照片手动跑一下）。

### 恢复

```powershell
# 1. 装依赖
npm install
# 2. 把备份里的配置放回去
Copy-Item "z:\相册备份\config-2026-09-25_1830\*" . -Recurse
# 3. 起服务
pwsh scripts/gallery.ps1 start
# 4. 对账：素材数量应该和备份目录里 healthz.txt 写的一致
Invoke-RestMethod http://127.0.0.1:8123/healthz
```

如果素材目录整个丢了，这个站救不了你——这就是第 3 条「照片本体必须另外备份」的原因。

---

## 5. 升级与改动

改代码之前先跑测试，改完再跑一次：

```powershell
npm test              # 31 条，零依赖，跑在临时目录里，不碰真实照片
```

拉取新版本：

```powershell
pwsh scripts/gallery.ps1 stop
git pull --ff-only
npm install           # 依赖有变化时才需要
pwsh scripts/gallery.ps1 start
```

**改了 `.env` 或 `featured.txt`**：`.env` 必须重启；`featured.txt` 只要点页面右上角
刷新按钮（或 `Invoke-RestMethod -Method Post http://127.0.0.1:8123/api/refresh`）。

**换素材目录 / 换机器** checklist：

1. 新目录里先跑 `npm run rescan`，确认扫到的数量符合预期（`MEDIA_ROOT` 先改好）
2. `.cache` 直接删掉——旧路径的缩略图缓存对新目录没用，留着只是占地方
3. `npm run warm` 烘一遍首页
4. `pwsh scripts/gallery.ps1 status` 收工

---

## 6. 缓存与磁盘

```powershell
"{0:N1} GB" -f ((Get-ChildItem .cache -Recurse | Measure-Object Length -Sum).Sum / 1GB)
```

- `.cache/thumbs` 按「宽度 + 原文件路径与修改时间的哈希」命名，同一张图不同宽度
  是不同文件。首页、列表、封面、灯箱各吃一个宽度，所以一张照片可能有 3~4 个缓存文件
- 单个 webp 大概 20~80 KB，3000 多张全烘完通常在几百 MB 量级
- **没有自动清理**：删照片不会删掉它的缓存。看着太大就直接删整个 `.cache`，
  下次访问会重建。想彻底一点：停服务 → 删 `.cache` → 起服务 → `npm run warm`

---

## 7. 性能

| 症状 | 先调这个 |
| --- | --- |
| 首屏慢 | `npm run warm`；`THUMB_WIDTH` 从 480 降到 400 也能省一截 |
| 机械硬盘上整页转圈 | `THUMB_CONCURRENCY=2`（默认 3），并发太高会把盘拖死 |
| 灯箱大图在手机上慢 | `PREVIEW_WIDTH` 降到 1280（注意：手机上能捏合放大到 4x，降太狠放大后会发虚） |
| 图片糊 | `THUMB_QUALITY` 提到 85（文件更大、更慢） |
| 一次拉走整库 | 有硬上限：`MAX_PAGE_SIZE=500`，接口层夹住，不用改 |
| 扫描慢 | 索引在 `.cache/index.json`，只要目录没大改，重启是秒级；真正慢的是首次全扫 |

---

## 8. 故障排查

| 现象 | 排查顺序 |
| --- | --- |
| 端口被占用起不来 | 启动器会直接说人话。`Get-NetTCPConnection -LocalPort 8123 -State Listen` 找到 PID，`Get-Process -Id <PID>` 看是谁。别的程序占了就改 `PORT` |
| 服务在跑，但 `localhost:8123` 开到的是另一个应用 | WSL / Docker 会把子系统的端口映射到 `127.0.0.1`，它比本站绑的 `0.0.0.0` 更具体，回环请求先给它（上面那条命令会看到 `wslrelay` 之类的占着 `127.0.0.1`）。局域网 IP 反而正常。最干脆的办法：改 `PORT` 换一个没被占的端口 |
| 页面能开、图全裂 | 素材目录不见了（移动硬盘拔了 / 盘符变了）。`npm run rescan` 看扫到几个 |
| 只有视频没封面 | `ffmpeg:false`。`npm i ffmpeg-static` 重启；公司网装不下来就 `FFMPEG_PATH` 指向系统装好的 ffmpeg |
| 动图按钮不出现 | 同上，`/api/site` 的 `anim` 是 false 就不显示按钮 |
| 背景音乐没声 / 播放坞不出现 | 先看 `Invoke-RestMethod http://127.0.0.1:8123/api/bgm` 的 `count`：为 0 就是 `bgm/` 没建、没音频、或扩展名不在 `AUDIO_EXTENSIONS` 里。有曲目则多半是自动播放限制：刷新后要**先碰一下屏幕**才起播；再不行是这台设备上次按过暂停（存在 localStorage，点播放键即可） |
| 背景音乐在手机上不响而电脑响 | 浏览器自动播放策略只认用户手势，不是 bug；确认已碰过屏幕，再看系统侧静音键与媒体音量 |
| 改了 `.env` 没生效 | 启动日志里那行「`.env` 已生效：…」有没有你改的键；没有就是那行写错了（等号两边、中文引号、缩进） |
| 手机能连但很卡 | 通常是 WiFi 信号或路由器性能，不是站点问题：在电脑上开 `http://localhost:8123` 对比 |
| 日志里一堆 404 `/favicon.ico` | 老浏览器行为。我们已经给了 SVG 图标与 `alternate icon`，还有就忽略 |
| 想确认没在写素材目录 | 站的全部写操作只发生在 `CACHE_DIR`；不放心就用只读方式挂载该目录再跑 |

**兜底行为**（设计上就不该整个挂掉，遇到请当 bug 报）：

- 单个坏图 → `/thumb` 307 重定向到原文件，页面照常出图，不会 500
- 单个视频抽帧超时 → 退回 SVG 占位封面
- 进程内未捕获异常 → 只记一行日志，服务继续跑
- 索引过期 → 后台重扫，当前请求继续用旧索引，不阻塞

---

## 9. 想对外网开放 / 上 https

**默认不建议**：这个站没有登录、没有权限模型，任何能连上端口的人都能看全部照片。

真要做，最小正确路径：

1. 前面放一层带**认证**的反代（nginx + Basic Auth，或 Tailscale 这类私有组网——
   后者是家里最省事的方案，不用暴露公网）
2. 上 https（局域网里可以用 mkcert 给自己签，手机要信任这个根证书）
3. `HOST=127.0.0.1`，只让反代访问，防火墙把 8123 的入站规则删掉
4. 变成 https 之后 Service Worker 才能注册，`public/sw.js` 会接管外壳离线
   （它只管外壳，照片与 `/api` 一律不缓存，这是刻意的）

### 非 Windows 部署（参考）

```ini
# /etc/systemd/system/family-gallery.service
[Unit]
Description=Family photo gallery
After=network-online.target

[Service]
Type=simple
User=dirk
WorkingDirectory=/home/dirk/FamilyNetwork
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# 敏感项写进 EnvironmentFile=/home/dirk/FamilyNetwork/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now family-gallery
journalctl -u family-gallery -f
```

Docker 也行（`legacy/` 里有旧版 compose 文件可参考），但要注意：容器要能读到
素材目录，并且**别把 `.cache` 写在容器层里**，重建就全没了——挂个卷进去。

---

## 10. 改代码须知

- **不要加依赖**。整个项目的能力边界就是「Express + sharp + ffmpeg」，
  需要什么都先问一句能不能三十行写完
- 前端没有构建：`public/index.html`（含全部样式）+ `public/app.js`，改完刷新就生效；
  新效果一律做**渐进增强**，能力探测在 `app.js` 顶部（`canVT` / `canSDA` / `canAnchor` /
  `finePointer`），不支持就当没这个功能
- 动效必须尊重 `prefers-reduced-motion`，`index.html` 末尾那一大块是统一的关闭开关
- 触屏改动要在 `@media (pointer: coarse)` 下确认点击目标 ≥ 44×44
- 灯箱手势统一走 Pointer Events（`bindGestures`）：单指滑=换张/下滑关闭，双指捏合与
  双击缩放，放大态下单指平移。`touch-action` 必须是 `none`（写成 `pan-y` 会让浏览器
  吃掉第二根手指的事件）；新加浮层手势别与视频的进度条/全屏抢，先 `closest('video,button,a')`
- 任何新接口都要走 `safeResolve`（路径类）并加测试；`/api` 一律 `no-store`
- 测试跑在独立临时目录里（`test/helpers/fixtures.js` 造素材），**永远不要**在测试里
  读真实的 `MEDIA_ROOT`
