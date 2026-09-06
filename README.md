# MakeWeight — make weight, with the numbers to prove it

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

Both download the latest release for your machine, unpack it (`~/Applications/MakeWeight`, `~/.local/opt/makeweight`,
`%LOCALAPPDATA%\Programs\MakeWeight`) and start it. Installed this way there is no macOS "unidentified developer"
prompt and no SmartScreen warning, because the files never pass through the browser's quarantine.

You can also download a zip from the Releases page, unzip it anywhere and start `MakeWeight.command` /
`MakeWeight.bat` / `makeweight.sh` — macOS will then ask once per download (System Settings → Privacy & Security →
Open Anyway).

## Updating

Jobs & setup → **Check for updates** → **Update now**. The app downloads the new version itself, starts it and hands
over; your data is in your user data folder and untouched. Older version folders are listed on that page and are safe
to delete. Coming from an older name (GRMLN, SliceBudget): the first start adopts that data folder automatically.

## First run

Open **Jobs & setup** and click **Install Bambu Studio** (or PrusaSlicer). MakeWeight downloads it into its data
folder and slices with it headlessly. Nothing is installed system-wide.

## Releasing (maintainers)

Tag a commit `vX.Y.Z` and push the tag. GitHub Actions builds the four platform zips with `build/make_dist.py`,
stamps the version and repository into the app, and publishes a Release with the zips and the installers.

## Renaming the app

The name lives in one place, `slicebudget/brand.json` (`name`, `slug`, `tagline`, `legacy_names`). Edit it, move the
old name into `legacy_names`, run `python3 build/sync_brand.py`, commit. The UI, data directory, launchers, zip names,
updater and installers all follow; existing users' data is adopted from the old name's folder on first start.

## Layout

- `slicebudget/` — the app (Python 3.12 standard library + numpy + openpyxl; the package keeps its original name)
- `build/make_dist.py` — packages an embedded Python runtime + wheels + app + launcher per platform
- `build/sync_brand.py` — pushes `brand.json` into the installers and this README's title
- `install.sh`, `install.ps1` — curl / irm installers that read the latest Release
