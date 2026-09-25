# ---------------------------------------------------------------------------
# 家庭相册 · 日常运维脚本（Windows / PowerShell 7）
#
#   pwsh scripts/gallery.ps1 start      后台启动，日志写 logs/
#   pwsh scripts/gallery.ps1 stop       停掉
#   pwsh scripts/gallery.ps1 restart    重启
#   pwsh scripts/gallery.ps1 status     看活着没有、索引多少素材
#   pwsh scripts/gallery.ps1 logs       最近 40 行日志
#   pwsh scripts/gallery.ps1 install    注册开机（登录后）自启
#   pwsh scripts/gallery.ps1 uninstall  取消自启
#
# 为什么用「登录时」而不是「开机时」：ONSTART 需要管理员权限，而且服务跑在
# SYSTEM 账户下读不到 F 盘的个人目录。家里的电脑本来就常年开着、自动登录，
# ONLOGON 是最省事也最不容易出怪事的做法。
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'install', 'uninstall')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$PidFile = Join-Path $LogDir 'gallery.pid'
$OutLog = Join-Path $LogDir 'gallery.out.log'
$ErrLog = Join-Path $LogDir 'gallery.err.log'

function Get-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw '找不到 node：先装 Node.js 20+，并确认它在 PATH 里（命令行敲 node -v 能看到版本号）。'
  }
  return $cmd.Source
}

# 端口交给 config 自己报，避免这里和 .env 各写一份、改一处忘一处
function Get-Port {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  $value = & (Get-Node) -p "require(process.argv[1]).port" (Join-Path $Root 'server\config.js') 2>$null
  $ErrorActionPreference = $prev
  if ($LASTEXITCODE -ne 0 -or -not $value) { return 8123 }
  return [int]$value
}

function Get-Health([int]$Port, [int]$TimeoutSec = 1) {
  try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec $TimeoutSec
    return $res
  } catch {
    return $null
  }
}

function Test-Running {
  if (-not (Test-Path $PidFile)) { return $null }
  $procId = (Get-Content $PidFile -First 1).Trim()
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc) { return [int]$procId }
  return $null
}

function Start-Gallery([int]$Port) {
  if (Get-Health $Port) {
    Write-Host "已经在跑了：http://localhost:$Port" -ForegroundColor Green
    return
  }
  if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
  }
  $node = Get-Node
  Write-Host "启动中（第一次扫描整个素材目录，可能要一两分钟）…" -ForegroundColor Cyan
  $proc = Start-Process -FilePath $node `
    -ArgumentList 'server\index.js' `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru
  $proc.Id | Out-File -FilePath $PidFile -Encoding ascii

  # 健康检查轮询而不是干等：起来了就说人话，起不来就把日志尾巴甩给你
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $health = Get-Health $Port
    if ($health) {
      Write-Host ("就绪：{0} 个素材（{1} 照片 / {2} 视频），{3} 本相册" -f `
          $health.items, $health.photos, $health.videos, $health.albums) -ForegroundColor Green
      Write-Host "家里其他设备：同一 WiFi 下打开 http://<这台电脑的IP>:$Port"
      return
    }
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { break }
  }
  Write-Host '没起来，最后几行日志：' -ForegroundColor Red
  Show-Logs 20
  throw '启动失败，详见 logs/gallery.err.log'
}

function Stop-Gallery {
  $procId = Test-Running
  if (-not $procId) {
    Write-Host '没有在跑（pid 文件里那个进程已经不在了）。' -ForegroundColor Yellow
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    return
  }
  Stop-Process -Id $procId -ErrorAction SilentlyContinue
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "已停止（PID $procId）。" -ForegroundColor Green
  Write-Host '注意：这个站只往 .cache 里写缩略图和索引，随时停都不会弄坏照片。'
}

function Show-Logs([int]$Lines) {
  foreach ($file in @($OutLog, $ErrLog)) {
    if (Test-Path $file) {
      Write-Host "==> $file" -ForegroundColor DarkGray
      Get-Content $file -Tail $Lines
    }
  }
}

function Get-StartupLink {
  # 「启动」文件夹：登进桌面就执行里面的东西，不弹 UAC、不需要管理员；
  # 想去掉也只是把这个快捷方式删掉，比计划任务好发现也好交接
  return Join-Path ([Environment]::GetFolderPath('Startup')) 'FamilyGallery.lnk'
}

function Install-Autostart {
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if (-not $pwsh) {
    throw '找不到 pwsh（PowerShell 7）。装一下 PowerShell 7，或者把启动文件夹里的快捷方式指向你常用的那个 shell。'
  }
  $script = Join-Path $PSScriptRoot 'gallery.ps1'
  $link = Get-StartupLink
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($link)
  $sc.TargetPath = $pwsh.Source
  $sc.Arguments = "-NoProfile -WindowStyle Hidden -File `"$script`" start"
  $sc.WorkingDirectory = $Root
  $sc.Description = '家庭相册：登录后自动起服务'
  $sc.WindowStyle = 7   # 7 = 最小化，登录时不抢窗口
  $sc.Save()
  Write-Host "已注册登录自启：$link" -ForegroundColor Green
  Write-Host '只在这台电脑登录进桌面后生效；要「开机就起、不登录也起」请看 docs/operations.md 里的计划任务写法。'
  Write-Host "取消：pwsh scripts/gallery.ps1 uninstall"
}

function Uninstall-Autostart {
  $link = Get-StartupLink
  if (-not (Test-Path $link)) {
    Write-Host '启动文件夹里没有这个快捷方式，不用取消。' -ForegroundColor Yellow
    return
  }
  Remove-Item $link
  Write-Host "已取消自启：$link" -ForegroundColor Green
}

$Port = Get-Port

switch ($Action) {
  'start' { Start-Gallery $Port }
  'stop' { Stop-Gallery }
  'restart' { Stop-Gallery; Start-Sleep -Seconds 2; Start-Gallery $Port }
  'status' {
    $health = Get-Health $Port
    $procId = Test-Running
    if ($health) {
      Write-Host ("运行中  http://localhost:{0}" -f $Port) -ForegroundColor Green
      Write-Host ("  素材   {0} 项（{1} 照片 / {2} 视频），{3} 本相册" -f $health.items, $health.photos, $health.videos, $health.albums)
      Write-Host ("  已跑   {0} 分钟" -f [math]::Round($health.uptimeSec / 60, 1))
      Write-Host ("  ffmpeg {0}   缓存可写 {1}" -f $(if ($health.ffmpeg) { '可用' } else { '不可用（视频只有占位封面）' }), $(if ($health.cacheWritable) { '是' } else { '否（磁盘满或没权限）' }))
      Write-Host ("  PID    {0}" -f $(if ($procId) { $procId } else { '未记录（可能是手动 npm start 起的）' }))
    } else {
      Write-Host "没在跑：端口 $Port 上没有相册服务。" -ForegroundColor Yellow
      Write-Host "  启动：pwsh scripts/gallery.ps1 start"
      if ($procId) { Write-Host "  但 pid 文件说进程 $procId 还在，可能卡在启动阶段，看看日志：pwsh scripts/gallery.ps1 logs" -ForegroundColor DarkYellow }
    }
    $autostart = Test-Path (Get-StartupLink)
    Write-Host ("  自启   {0}" -f $(if ($autostart) { '已注册（登录后自动启动）' } else { '未注册' }))
  }
  'logs' { Show-Logs 40 }
  'install' { Install-Autostart }
  'uninstall' { Uninstall-Autostart }
}
