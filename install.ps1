# GRMLN installer for Windows (PowerShell).
#   irm https://raw.githubusercontent.com/OWNER/REPO/main/install.ps1 | iex
# Downloads the latest release into %LOCALAPPDATA%\Programs\GRMLN (override with $env:GRMLN_DIR), clears the
# "downloaded from the internet" mark so SmartScreen stays quiet, and starts it.
$ErrorActionPreference = "Stop"
$Repo = if ($env:GRMLN_REPO) { $env:GRMLN_REPO } else { "__REPO__" }
if ($Repo -eq "__REPO__" -or -not $Repo) { Write-Host "GRMLN: no repository configured. Run:  `$env:GRMLN_REPO='owner/name'; irm .../install.ps1 | iex"; exit 1 }
$Dest = if ($env:GRMLN_DIR) { $env:GRMLN_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\GRMLN" }
Write-Host "GRMLN: looking up the latest release of $Repo ..."
$rel = Invoke-RestMethod -Headers @{ "User-Agent" = "GRMLN-installer" } "https://api.github.com/repos/$Repo/releases/latest"
$asset = $rel.assets | Where-Object { $_.name -like "GRMLN-*-windows-x86_64.zip" } | Select-Object -First 1
if (-not $asset) { Write-Host "GRMLN: no Windows release asset found in $Repo"; exit 1 }
$Name = [IO.Path]::GetFileNameWithoutExtension($asset.name)
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$zip = Join-Path $env:TEMP $asset.name
Write-Host "GRMLN: downloading $($asset.name) ..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
Unblock-File $zip
$target = Join-Path $Dest $Name
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Write-Host "GRMLN: unpacking into $target ..."
Expand-Archive -Path $zip -DestinationPath $Dest -Force
Remove-Item $zip -Force
Get-ChildItem -Path $target -Recurse -File | Unblock-File
$shortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "GRMLN.lnk"
try {
  $ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut($shortcut)
  $sc.TargetPath = Join-Path $target "GRMLN.bat"; $sc.WorkingDirectory = $target; $sc.Description = "GRMLN — every gram accounted for"; $sc.Save()
  Write-Host "GRMLN: desktop shortcut created."
} catch { Write-Host "GRMLN: (could not create a desktop shortcut: $_)" }
Write-Host "GRMLN: installed. Starting ..."
Start-Process -FilePath (Join-Path $target "GRMLN.bat") -WorkingDirectory $target
