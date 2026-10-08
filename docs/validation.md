# TimeLog 1.0.5 validation

Date: October 8, 2026.

## Results

- TypeScript check and application build: passed.
- Domain suite: 167 tests passed.
- Migration and SQLite constraints: 47 checks passed.
- Electron scenario: forms, overlaps, rates, PDF, backups, timer recovery, short entries, Pomodoro, and hiding in the tray passed.
- Reports: 20 rapid Month → Week switches, with no renderer errors.
- Version 1.0.5 changes: date and time input guards, duration limits, full-width timer bar, and descending entry order passed.
- Pomodoro: ending work with the main window hidden opens the alert window. Electron loads the WAV, plays it, and loops it. Dismiss stops the sound. A new work entry starts only after Start work confirmation.

Checks used separate test databases. Windows test processes used TIMELOG_TEST_NO_SANDBOX=1 in the isolated environment. The released application enables sandbox and contextIsolation, with nodeIntegration disabled.

## Installer

Electron Builder completed the per-user Windows NSIS x64 installer. TimeLog-Setup-1.0.5.exe size: 121643806 bytes.

SHA256: `8307dc25ae0d504fd80bc3540e70a7d6455adf0602746f91082081b762c8730c`.

The developer compared the output copies and verified the 76 files in the embedded archive with 7-Zip. Installing and uninstalling version 1.0.5 on the user's laptop still require a manual check. The sound check confirms Electron playback; speaker volume depends on Windows settings. Laptop sleep was not tested at the user's request.
