# Installer for Windows (PowerShell).
#   irm https://raw.githubusercontent.com/OWNER/REPO/main/install.ps1 | iex
# Downloads the latest release into %LOCALAPPDATA%\Programs\<App> (override with $env:MAKEWEIGHT_DIR), clears the
# "downloaded from the internet" mark so SmartScreen stays quiet, and starts it.
# $App / $Tagline mirror slicebudget/brand.json — run `python3 build/sync_brand.py` after changing that file.
$ErrorActionPreference = "Stop"
$App = "MakeWeight"
$Tagline = "make weight, with the numbers to prove it"
$Repo = if ($env:MAKEWEIGHT_REPO) { $env:MAKEWEIGHT_REPO } else { "__REPO__" }
if ($Repo -eq "__REPO__" -or -not $Repo) { Write-Host "$App: no repository configured. Run:  `$env:MAKEWEIGHT_REPO='owner/name'; irm .../install.ps1 | iex"; exit 1 }
$Dest = if ($env:MAKEWEIGHT_DIR) { $env:MAKEWEIGHT_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\$App" }
Write-Host "$App: looking up the latest release of $Repo ..."
$rel = Invoke-RestMethod -Headers @{ "User-Agent" = "$App-installer" } "https://api.github.com/repos/$Repo/releases/latest"
$asset = $rel.assets | Where-Object { $_.name -like "$App-*-windows-x86_64.zip" } | Select-Object -First 1
if (-not $asset) { Write-Host "$App: no Windows release asset found in $Repo"; exit 1 }
$Name = [IO.Path]::GetFileNameWithoutExtension($asset.name)
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$zip = Join-Path $env:TEMP $asset.name
Write-Host "$App: downloading $($asset.name) ..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
Unblock-File $zip
$target = Join-Path $Dest $Name
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Write-Host "$App: unpacking into $target ..."
Expand-Archive -Path $zip -DestinationPath $Dest -Force
Remove-Item $zip -Force
Get-ChildItem -Path $target -Recurse -File | Unblock-File
$shortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "$App.lnk"
try {
  $ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut($shortcut)
  $sc.TargetPath = Join-Path $target "$App.bat"; $sc.WorkingDirectory = $target; $sc.Description = "$App - $Tagline"; $sc.Save()
  Write-Host "$App: desktop shortcut created."
} catch { Write-Host "$App: (could not create a desktop shortcut: $_)" }
Write-Host "$App: installed. Starting ..."
Start-Process -FilePath (Join-Path $target "$App.bat") -WorkingDirectory $target
