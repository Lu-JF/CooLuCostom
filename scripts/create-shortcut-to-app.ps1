# 把「桌宠 Coo」快捷方式指到官方安装版（装到别处时改 $exe 再跑一次）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-shortcut-to-app.ps1
$ErrorActionPreference = 'Stop'

$exe   = 'D:\Sorftware\Coopanion\Coopanion.exe'
$name  = '桌宠 Coo.lnk'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk   = Join-Path $desktop $name

if (-not (Test-Path -LiteralPath $exe)) { throw "找不到官方版主程序：$exe" }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath       = $exe
$sc.WorkingDirectory = Split-Path -Parent $exe
$sc.IconLocation     = "$exe,0"
$sc.Description      = '桌宠 Coo（官方安装版）'
$sc.Save()

$check = $shell.CreateShortcut($lnk)
"{0} → {1}" -f $lnk, $check.TargetPath
