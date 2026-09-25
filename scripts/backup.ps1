# ---------------------------------------------------------------------------
# 家庭相册 · 备份脚本（Windows / PowerShell 7）
#
#   pwsh scripts/backup.ps1                          备份到 .\backups\
#   pwsh scripts/backup.ps1 -Destination "z:\相册备份"  备份到网盘/NAS 挂载盘
#   pwsh scripts/backup.ps1 -Keep 7                  只留最近 7 份
#
# 备份的是什么：只有「重建很贵」的那几样——配置、精选清单、排除规则，以及扫描
# 索引和视频时长表（3714 个文件重扫一遍要一两分钟，抽帧时长更久）。
#
# 备份里【没有】照片：照片就是这个站本身，它只读不写，一张都不会碰。
# 真要保护的是 F 盘那个目录，请用系统备份或网盘同步，别指望这个脚本。
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
  [string]$Destination = '',
  [int]$Keep = 14
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot

# 相对路径按当前目录解释，这里统一成仓库根下的绝对路径
if (-not $Destination) {
  $Destination = Join-Path $Root 'backups'
} elseif (-not [System.IO.Path]::IsPathRooted($Destination)) {
  $Destination = Join-Path (Get-Location) $Destination
}

# 每一项都是「有就备、没有就跳过」：比如 featured.txt 是可选的
$Wanted = @(
  '.env',
  'featured.txt',
  '.galleryignore',
  '.cache\index.json',
  '.cache\durations.json'
)

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$target = Join-Path $Destination "config-$stamp"
New-Item -ItemType Directory -Path $target -Force | Out-Null

$copied = 0
foreach ($rel in $Wanted) {
  $src = Join-Path $Root $rel
  if (-not (Test-Path $src)) {
    Write-Host "  跳过  $rel（不存在）" -ForegroundColor DarkGray
    continue
  }
  $dest = Join-Path $target $rel
  New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
  Copy-Item $src $dest
  $size = [math]::Round((Get-Item $dest).Length / 1KB, 1)
  Write-Host "  备份  $rel  ($size KB)"
  $copied++
}

if ($copied -eq 0) {
  Remove-Item $target -Recurse -Force
  throw '什么都没备份到：确认 .env 或 .cache 是不是被 CACHE_DIR 指到别处去了。'
}

# 记一笔当时的状态，出问题翻备份时能知道那天索引是多少
$port = & (Get-Command node).Source -p "require(process.argv[1]).port" (Join-Path $Root 'server\config.js') 2>$null
if (-not $port) { $port = 8123 }
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
  "items=$($health.items) photos=$($health.photos) videos=$($health.videos) albums=$($health.albums)" |
    Out-File -FilePath (Join-Path $target 'healthz.txt') -Encoding utf8
} catch {
  Write-Host '  提示  服务没在跑，healthz.txt 这次没写成（不影响备份本身）。' -ForegroundColor DarkGray
}

# 只留最近 N 份：备份目录塞满的话，没人会去删，最后连盘都进不去
$Old = Get-ChildItem -Path $Destination -Directory -Filter 'config-*' |
  Sort-Object Name -Descending |
  Select-Object -Skip $Keep
foreach ($dir in $Old) {
  Write-Host "  清理  $($dir.Name)" -ForegroundColor DarkGray
  Remove-Item $dir.FullName -Recurse -Force
}

Write-Host ''
Write-Host "备份完成：$target（$copied 个文件，保留最近 $Keep 份）" -ForegroundColor Green
Write-Host '建议：把这个脚本挂到计划任务里每周跑一次，目标地址写你的移动硬盘或 NAS。'
