# Windows development without ZIP replacements

The source stays in GitHub on the **development** branch. A small local updater copies its extension files into your existing Brave installation:

```text
C:\Users\richh\Downloads\thecalm-skip
```

You keep the same unpacked extension and its settings. You do not load a second copy for each update. A Chrome Web Store developer account is not needed for this development workflow.

## 1. Prepare Windows once

Install [Git for Windows](https://git-scm.com/download/win) if `git --version` is not available. Its normal installation includes Git Credential Manager. For a private GitHub repository, complete its browser sign-in when Git prompts; do not put credentials into the updater or share tokens in chat.

Open **PowerShell** on your Windows computer. Windows PowerShell 5.1 is sufficient; Node.js and Python are not needed just to sync and use the extension.

After the `development` branch has been published, clone it into a separate source folder:

```powershell
New-Item -ItemType Directory -Force "$HOME\source" | Out-Null
git clone --branch development https://github.com/richhiiee/TheCalm.git "$HOME\source\TheCalm"
Set-Location "$HOME\source\TheCalm"
```

Do not clone into the installed extension folder. The updater deliberately refuses overlapping source and installation folders.

## 2. Sync the existing installation

Close existing TheCalm/player tabs, then run:

```powershell
& .\scripts\sync-dev.ps1 -InstallDirectory 'C:\Users\richh\Downloads\thecalm-skip'
```

If PowerShell specifically reports that running scripts is disabled, inspect your policy:

```powershell
Get-ExecutionPolicy -List
```

On a personal, unmanaged computer, the supported user-level development policy is:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Review that change and answer the normal PowerShell prompt, then rerun the sync command. `RemoteSigned` allows locally created Git checkout scripts and retains the signature requirement for scripts marked as Internet downloads. Do not override an organization-managed policy or use `Bypass` to run this updater.

After a changed sync, open `brave://extensions` and click **Reload** on the existing **TheCalm Skip** extension. Reopen TheCalm. The popup version should match the source manifest and **Automatic skipping** should be on unless you deliberately paused it.

Only one enabled copy of TheCalm Skip should remain. Files are updated automatically by the following watch mode, but Brave's **Reload** step remains manual during development.

## 3. Receive cloud development updates

Keep this command running in a PowerShell window:

```powershell
Set-Location "$HOME\source\TheCalm"
& .\scripts\sync-dev.ps1 -Pull -Watch -InstallDirectory 'C:\Users\richh\Downloads\thecalm-skip'
```

It checks GitHub once per minute and local extension files every two seconds. When a tested change is pushed to `development`, it fast-forwards the clean checkout and copies only changed extension files into the installed folder. Its message tells you when to reload Brave. Unchanged files cause no copy, backup, or repeated reload message.

Press **Ctrl+C** to stop. Closing the PowerShell window also stops watching. This setup does not add a scheduled task or change how Windows starts.

If an update changes `scripts/sync-dev.ps1` itself, stop and restart the watch command to use the new updater code.

For a one-time update instead:

```powershell
& .\scripts\sync-dev.ps1 -Pull -InstallDirectory 'C:\Users\richh\Downloads\thecalm-skip'
```

## 4. Edit and test locally

While editing the local checkout, omit `-Pull`:

```powershell
& .\scripts\sync-dev.ps1 -Watch -InstallDirectory 'C:\Users\richh\Downloads\thecalm-skip'
```

Local saves then copy to the installed extension folder within about two seconds. Reload the extension and reopen its episode after a set of edits. The updater validates the manifest and local resource references, but it is not a JavaScript test runner.

`-Pull` mode refuses dirty checkouts, detached branches, branch changes while watching, and non-fast-forward updates. It does not stash, discard edits, switch branches, or force-reset anything. A failed pull blocks deployment until a later pull succeeds. If you make local edits, stop `-Pull` mode and preserve or commit your work before resuming it.

To run the repository's automated checks locally, install Node.js 20 or newer and follow the development commands in [README.md](../README.md). The browser harness also needs a compatible Chromium executable, selected with `CHROMIUM_PATH`; copying and using the extension does not require those test tools.

## Backups and safety

Before replacing an installed managed file, the updater backs it up outside the loaded extension directory:

```text
C:\Users\richh\Downloads\thecalm-skip-dev-sync\backups\<timestamp>
```

State is kept alongside those backups in `thecalm-skip-dev-sync\state.json`. Unknown files in the installation are left alone. A retired file previously managed by the updater is removed only when it still matches the last deployed hash; modified retired files are preserved with a warning.

The updater validates and stages the source before writing, refuses symbolic links/junctions in managed paths, and refuses a destination belonging to another extension. If copying fails, it attempts to restore every changed file. A filesystem or permission problem can also block a restore; in that case it continues restoring the others and reports the failed files and backup directory for manual recovery. Do not edit the state file or use the installed folder as the development source. Make code edits in `$HOME\source\TheCalm` instead.

The current cloud session cannot access your Windows drive. The first clone and updater command must run on your Windows computer. Afterward, GitHub provides the transfer path for cloud changes; no repeated ZIP download or manual file replacement is needed.
