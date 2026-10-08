# TimeLog 1.0.5

A personal time logger for Windows 10/11 x64. TimeLog runs locally, requires no account, and keeps your data on your computer. The application interface and this repository use English.

## Install

Download **TimeLog-Setup-1.0.5.exe** from [Releases](https://github.com/abdulloev-n/TimeLog/releases/latest). Quit any running copy using the tray icon → Quit, then open the installer. Installation is per user, with desktop and Start Menu shortcuts.

TimeLog stores entries, settings, and invoices in `%APPDATA%\TimeLog\timelog.sqlite`. Updates and uninstalling preserve this folder. Open it through Settings → Data → Open folder.

Closing the main window hides TimeLog in the tray. Use the tray menu → Quit to exit. A running timer survives restart and includes elapsed time while the computer is off. TimeLog stops entries at the 24-hour limit or before the next saved entry. If you move the system clock earlier than the timer start, correct the start through Edit.

This repository publishes version 1.0.5. You can build a portable executable from the source.

## Screens

- **Day:** daily entries, week progress, timer, and day timeline. Drag empty timeline space to create an entry. Move a block or drag its top or bottom edge to edit the interval.
- **Reports:** week and month views, hours, earnings by currency, project and tag breakdowns, invoices, and PDF export.
- **Projects:** projects and clients, hourly rates with currency selection, archive, and restore.
- **Settings:** theme, time format, goals, Pomodoro, global shortcut, sender details, backups, and tags.

## Entries and earnings

Manual entries last from one minute to 24 hours. Stopping a timer under one minute deletes that entry. Adjacent entries may touch; overlapping entries are rejected. An entry crossing midnight remains one database record, with a segment displayed on each affected day.

Each entry keeps its project's rate and currency from creation. Changing a project rate affects new entries. To change an existing entry's rate, use Edit time entry → Entry rate → Change this entry’s rate. Moving an entry to another project uses that project's current rate.

Supported currencies: USD, GBP, EUR, TJS, TRY, CNY, RUB, KZT, CHF, AED. Reports show a separate amount for each currency, without currency conversion. An invoice uses one currency. A project with multiple historical rates produces separate invoice lines.

Earnings use exact durations. TimeLog groups time by project, currency, and rate, rounds each group's amount to minor units, and then sums the groups. Reports and invoices share this calculation. PDF invoices display hours with two decimal places.

Issued invoices store snapshots of the sender, client, and lines. They cannot be edited or deleted. Numbers use a global increasing sequence. Importing a backup on the same computer preserves the larger of the current and imported counters. When moving an old backup to another computer, check numbers of invoices already sent.

## Pomodoro

When work or a break ends, TimeLog opens a separate window above other windows and repeats a sound. **Start break / Start work** starts the next phase. **Dismiss** stops the sound and leaves Pomodoro waiting. The next work phase creates an entry only after confirmation.

Alerts work while TimeLog runs, including when the main window is hidden in the tray. After restart, TimeLog restores pending confirmation. Check TimeLog's volume in the Windows mixer if you cannot hear the sound.

## Backups

Settings → Data → Export saves the database to a file you choose. Import replaces the current database after confirmation. Before replacement, TimeLog saves `backup-before-import-<timestamp>.sqlite` in the data folder and validates the incoming file.

For normal writes, TimeLog writes a temporary file, flushes it, and replaces the database file. It retains the previous copy as `timelog.sqlite.bak`. If the database is damaged, TimeLog attempts recovery from that copy and preserves the damaged file.

## Build from source

Requirements: Windows x64, Node.js 24 LTS with npm, and .NET Framework 4.8 for portable builds. Open a terminal in the source directory.

```powershell
npm install
npm run dev
```

Build the NSIS installer:

```powershell
npm run dist:installer
```

Output: `dist\TimeLog-Setup-1.0.5.exe`. The Electron Builder configuration in `package.json` enables per-user installation, desktop and Start Menu shortcuts, and preserves user data on uninstall.

Build the portable executable:

```powershell
npm run dist
```

Output: `dist\TimeLog-Portable-1.0.5.exe`. Electron Builder prepares the application; `scripts/portable.ps1` packages it with `scripts/PortableLauncher.cs`. The launcher extracts files into `%LOCALAPPDATA%\TimeLog\portable-cache`, validates extraction paths, and prevents simultaneous extraction. Portable and installed copies use the same user database.

The application makes no network requests during use. Installing dependencies and building require downloads through npm and Electron Builder.

## Checks

```powershell
npm run typecheck
npm test
npm run verify:migrations
npm run test:store
npm run test:desktop
npm run test:reports
npm run test:revisions
```

The domain suite contains 167 tests. The migration script runs 47 SQLite checks. Store tests cover persistence, timer recovery, references and cascades, historical rates, invoices, and rollback after a failed save. Electron checks cover forms, overlap protection, time precision, projects and tags, PDF, backups, restart, short timers, Pomodoro, and hiding in the tray. Reports checks include 20 rapid Month → Week switches.

Windows checks in the isolated development environment used `TIMELOG_TEST_NO_SANDBOX=1` for test processes. The released application enables `sandbox` and `contextIsolation`, with `nodeIntegration` disabled. UI checks use separate test databases.

See [validation notes](docs/validation.md) and the [domain integration guide](docs/domain-integration.md).

## Limitations and first-install checks

- The executable is unsigned. Windows may display a warning when opening it.
- Tag uniqueness ignores case for ASCII A–Z only; `Étude` and `étude` can be separate tags.
- An entry with multiple tags contributes to each tag, so tag totals can exceed the period total.
- TimeLog does not mark entries as invoiced. Review the period before issuing another invoice.
- After restart, Pomodoro ends an expired phase and waits for Start break / Start work.
- Global shortcuts and Windows notifications depend on operating-system settings. Pomodoro's phase alert uses a separate application window.

After installation, check application launch, the tray icon, Ctrl+Alt+T, Pomodoro sound and confirmation buttons, and timeline dragging. Save a PDF and export a backup. Version 1.0.5 installation and uninstallation still require a manual check; the automated checks cover the application and installer contents.

## Architecture

`src/domain` contains time, rate, report, and invoice rules. `src/main/store.ts` opens SQLite WASM, applies migrations, and runs transactions. `src/main/main.ts` manages IPC, windows, tray, timer, Pomodoro, PDF, and backups. `src/main/preload.ts` exposes the typed API. `src/renderer` contains React, Zustand, forms, and styling.

`APP_NAME` lives in `src/shared/types.ts`. When renaming the application, update `productName`, `appId`, and artifact names in `package.json`. Preserve the existing data folder if you want to keep using the same database.
