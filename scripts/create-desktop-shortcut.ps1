# Create a Desktop shortcut that starts the Coo pet.
# The Chinese name/description are base64-encoded so this file stays pure ASCII.
$ErrorActionPreference = 'Stop'
$decode = { param($b64) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }

$repo    = 'D:\Work_AI\Coopanion-Usage'
$target  = Join-Path $env:SystemRoot 'System32\wscript.exe'
$vbsArgs = '"' + (Join-Path $repo 'scripts\start-pet.vbs') + '"'
$icon    = Join-Path $repo 'upstream\coopanion\app\icons\icon.ico'
$name    = & $decode '5qGM5a6gIENvbw=='
$desc    = & $decode '5qGM5a6gIENvb++8iENvb3BhbmlvbiDCtyDmjqfliLblj7AgaHR0cDovLzEyNy4wLjAuMToxNzc4OO+8iQ=='

$desktop = [Environment]::GetFolderPath('Desktop')
$link    = Join-Path $desktop ($name + '.lnk')

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath       = $target
$sc.Arguments        = $vbsArgs
$sc.WorkingDirectory = (Join-Path $repo 'upstream\coopanion')
$sc.Description      = $desc
$sc.WindowStyle      = 1   # 普通；窗口有没有、由 wscript 那边决定（vbs 里是隐藏启动）
if (Test-Path $icon) { $sc.IconLocation = $icon }
$sc.Save()

$check = $shell.CreateShortcut($link)
"created : $link"
"target  : " + $check.TargetPath
"args    : " + $check.Arguments
"workdir : " + $check.WorkingDirectory
"icon    : " + $check.IconLocation
"exists  : " + (Test-Path $link)
