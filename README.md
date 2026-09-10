# MakeWeight — make weight, with the numbers to prove it

Weight budgeting for combat robots: a local app that slices your printed parts for real (Bambu Studio or
PrusaSlicer, headless), keeps the weight sheet for every robot, weighs in, and finds the print profiles that get the
whole robot under its class limit.

## Install

**macOS / Linux** — paste into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/13djwright/MakeWeight/main/install.sh | sh
```

**Windows** — paste into PowerShell:

```powershell
irm https://raw.githubusercontent.com/13djwright/MakeWeight/main/install.ps1 | iex
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
to delete. Data from any earlier version (or an earlier name of the app) is adopted automatically on first start.

## Using it on more than one computer

Jobs & setup → **Use a shared folder…**: pick a folder inside a cloud drive (iCloud Drive, OneDrive, Dropbox, Google
Drive — the ones present on the machine are offered, and the folder picker marks any folder that already holds MakeWeight
data with a ✓). Choose **Move my data there** on the first computer and **Use the data already there** on each other one —
point at the folder that contains `data/` (the drive has a different path on every computer, e.g.
`~/Library/CloudStorage/GoogleDrive-…/My Drive/MakeWeight` on a Mac and `G:\My Drive\MakeWeight` on Windows). Robots, filaments, profiles and weigh-ins are then read from and written to
that folder; the slicer install, caches and machine-specific settings stay on each computer. Only one computer uses the
data at a time: a copy that sits idle (5 minutes by default, adjustable) releases it automatically, and another computer
then picks it up on its next action. If the other computer is still busy you can **take over** — it pauses itself and
shows a resume notice — so a machine left running somewhere never blocks you. **Stop sharing** copies the data back to
the computer.

## First run

Open **Jobs & setup** and click **Install Bambu Studio** (or PrusaSlicer). MakeWeight downloads it into its data
folder and slices with it headlessly. Nothing is installed system-wide.

## Releasing (maintainers)

Tag a commit `vX.Y.Z` and push the tag. GitHub Actions builds the four platform zips with `build/make_dist.py`,
stamps the version and repository into the app, and publishes a Release with the zips and the installers.

## Renaming the app

The name lives in one place, `makeweight/brand.json` (`name`, `slug`, `tagline`, `legacy_names`). Edit it, move the
old name into `legacy_names`, run `python3 build/sync_brand.py`, commit. The UI, data directory, launchers, zip names,
updater and installers all follow; existing users' data is adopted from the old name's folder on first start.

## Layout

- `makeweight/` — the app (Python 3.12 standard library + numpy + openpyxl)
- `build/make_dist.py` — packages an embedded Python runtime + wheels + app + launcher per platform
- `build/sync_brand.py` — pushes `brand.json` into the installers and this README's title
- `install.sh`, `install.ps1` — curl / irm installers that read the latest Release

## License

Copyright © 2026 Devin Wright (13djwright).

MakeWeight is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version — see [LICENSE](LICENSE). It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY.
Every copy or derivative must keep this copyright notice and stay under the GPL. Bambu Studio and PrusaSlicer are
separate programs (AGPL-3.0, downloaded on first run), not part of this distribution.
