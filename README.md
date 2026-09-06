# GRMLN — every gram accounted for

Weight budgeting for combat robots: a local app that slices your printed parts for real (Bambu Studio or
PrusaSlicer, headless), keeps the weight sheet for every robot, weighs in, and finds the print profiles that get the
whole robot under its class limit.

## Install

**macOS / Linux** — paste into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/install.sh | sh
```

**Windows** — paste into PowerShell:

```powershell
irm https://raw.githubusercontent.com/OWNER/REPO/main/install.ps1 | iex
```

Both download the latest release for your machine, unpack it (`~/Applications/GRMLN`, `~/.local/opt/grmln`,
`%LOCALAPPDATA%\Programs\GRMLN`) and start it. Installed this way there is no macOS "unidentified developer" prompt
and no SmartScreen warning, because the files never pass through the browser's quarantine.

You can also download a zip from the Releases page, unzip it anywhere and start `GRMLN.command` / `GRMLN.bat` /
`grmln.sh` — macOS will then ask once per download (System Settings → Privacy & Security → Open Anyway).

## Updating

Jobs & setup → **Check for updates** → **Update now**. The app downloads the new version itself, starts it and hands
over; your data is in your user data folder and untouched. Older version folders are listed on that page and are safe
to delete.

## First run

Open **Jobs & setup** and click **Install Bambu Studio** (or PrusaSlicer). GRMLN downloads it into its data folder and
slices with it headlessly. Nothing is installed system-wide.

## Releasing (maintainers)

Tag a commit `vX.Y.Z` and push the tag. GitHub Actions builds the four platform zips with `build/make_dist.py`,
stamps the version and repository into the app, and publishes a Release with the zips and the installers.

## Layout

- `slicebudget/` — the app (Python 3.12 standard library + numpy + openpyxl; the package keeps its original name)
- `build/make_dist.py` — packages an embedded Python runtime + wheels + app + launcher per platform
- `install.sh`, `install.ps1` — curl / irm installers that read the latest Release
