#requires -Version 5.1
<#
.SYNOPSIS
Keeps an unpacked Brave extension in sync with a local development checkout.
.DESCRIPTION
Copies only extension resources, backs up replaced managed files, and leaves
unrecognized files alone. -Pull uses the checkout's existing Git upstream and
refuses local changes. -Watch checks local files every two seconds; with -Pull,
upstream checks happen at most once per PullIntervalSeconds.
#>
[CmdletBinding()]
param(
    [string] $SourceDirectory = (Split-Path -Parent $PSScriptRoot),
    [string] $InstallDirectory = 'C:\Users\richh\Downloads\thecalm-skip',
    [switch] $Pull,
    [switch] $Watch,
    [ValidateRange(1, 3600)] [int] $PollSeconds = 2,
    [ValidateRange(15, 86400)] [int] $PullIntervalSeconds = 60
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ExpectedName = 'TheCalm Skip'
$StateSchema = 1

function Get-FullDirectory([string] $Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { return $full.TrimEnd([char[]] @('/', '\')) }
    return $full
}

function Test-Within([string] $Path, [string] $Directory) {
    return $Path.Equals($Directory, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($Directory.TrimEnd([char[]] @('/', '\')) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath([string] $Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing a symbolic link or junction in the development path: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Get-SafeFiles([string] $Directory) {
    Assert-NoReparsePath $Directory
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($Directory)
    $files = New-Object 'System.Collections.Generic.List[object]'
    while ($queue.Count -gt 0) {
        $folder = $queue.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $folder -Force)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing a symbolic link or junction in the extension: $($item.FullName)"
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
            else {
                $relative = $item.FullName.Substring($Directory.Length).TrimStart([char[]] @('/', '\')).Replace('\', '/')
                $files.Add([PSCustomObject] @{ Relative = $relative; Path = $item.FullName })
            }
        }
    }
    return @($files | Sort-Object Relative)
}

function Get-ResourcePath([string] $Root, [string] $Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or
        $Relative -match '(^|[\\/])\.\.([\\/]|$)' -or $Relative.Contains(':') -or
        $Relative.IndexOfAny([char[]] @('*', '?', '[', ']')) -ge 0) {
        throw "Invalid local extension resource: $Relative"
    }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not (Test-Within $full $Root) -or $full -eq $Root) { throw "Resource escapes the extension folder: $Relative" }
    Assert-NoReparsePath $full
    return $full
}

function Assert-Resource([string] $Root, [string] $Relative) {
    $path = Get-ResourcePath $Root $Relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing extension resource: $Relative" }
}

function Add-Properties($Object, $List) {
    if ($null -eq $Object) { return }
    foreach ($property in $Object.PSObject.Properties) { $List.Add([string] $property.Value) }
}

function Get-ValidatedManifest([string] $Root) {
    $manifestPath = Join-Path $Root 'manifest.json'
    Assert-NoReparsePath $manifestPath
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "No manifest.json in $Root" }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'The extension manifest is not valid JSON.' }
    if ($manifest.manifest_version -ne 3 -or $manifest.name -ne $ExpectedName -or
        [string] $manifest.version -notmatch '^\d{1,5}(\.\d{1,5}){0,3}$') {
        throw "Expected a Manifest V3 '$ExpectedName' extension with a valid version."
    }
    foreach ($part in ([string] $manifest.version).Split('.')) {
        if ([int] $part -gt 65535) { throw 'The extension version has a component greater than 65535.' }
    }
    $resources = New-Object 'System.Collections.Generic.List[string]'
    $properties = @($manifest.PSObject.Properties.Name)
    if ($properties -contains 'background') {
        if (@($manifest.background.PSObject.Properties.Name) -contains 'service_worker') { $resources.Add([string] $manifest.background.service_worker) }
        if (@($manifest.background.PSObject.Properties.Name) -contains 'scripts') { foreach ($file in $manifest.background.scripts) { $resources.Add([string] $file) } }
    }
    if ($properties -contains 'action') {
        if (@($manifest.action.PSObject.Properties.Name) -contains 'default_popup') { $resources.Add([string] $manifest.action.default_popup) }
        if (@($manifest.action.PSObject.Properties.Name) -contains 'default_icon') {
            if ($manifest.action.default_icon -is [string]) { $resources.Add($manifest.action.default_icon) }
            else { Add-Properties $manifest.action.default_icon $resources }
        }
    }
    if ($properties -contains 'icons') { Add-Properties $manifest.icons $resources }
    if ($properties -contains 'content_scripts') {
        foreach ($entry in $manifest.content_scripts) {
            foreach ($key in @('js', 'css')) {
                if (@($entry.PSObject.Properties.Name) -contains $key) {
                    foreach ($file in $entry.$key) { $resources.Add([string] $file) }
                }
            }
        }
    }
    foreach ($key in @('options_page', 'devtools_page')) {
        if ($properties -contains $key) { $resources.Add([string] $manifest.$key) }
    }
    if ($properties -contains 'options_ui') { $resources.Add([string] $manifest.options_ui.page) }
    if ($properties -contains 'side_panel') { $resources.Add([string] $manifest.side_panel.default_path) }
    if ($properties -contains 'chrome_url_overrides') { Add-Properties $manifest.chrome_url_overrides $resources }
    if ($properties -contains 'sandbox') { foreach ($file in $manifest.sandbox.pages) { $resources.Add([string] $file) } }
    if ($properties -contains 'declarative_net_request') {
        foreach ($entry in $manifest.declarative_net_request.rule_resources) { $resources.Add([string] $entry.path) }
    }
    if ($properties -contains 'web_accessible_resources') {
        foreach ($entry in $manifest.web_accessible_resources) {
            foreach ($pattern in $entry.resources) {
                if ($pattern -match '(^|[\\/])\.\.([\\/]|$)' -or $pattern.Contains(':') -or [IO.Path]::IsPathRooted($pattern)) {
                    throw "Invalid web-accessible resource: $pattern"
                }
                if ($pattern.Contains('*')) {
                    $matches = @(Get-ChildItem -Path (Join-Path $Root $pattern) -File)
                    if ($matches.Count -eq 0) { throw "No local files match web-accessible resource: $pattern" }
                } else { $resources.Add([string] $pattern) }
            }
        }
    }
    foreach ($resource in $resources) { Assert-Resource $Root $resource }
    foreach ($file in @(Get-SafeFiles $Root)) {
        if ($file.Relative -match '\.html?$') {
            $html = Get-Content -LiteralPath $file.Path -Raw -Encoding UTF8
            foreach ($match in [regex]::Matches($html, '<(?:script|link|img)\b[^>]*(?:src|href)=["'']([^"'']+)["'']', 'IgnoreCase')) {
                $ref = $match.Groups[1].Value
                if ($ref -match '^[a-z][a-z0-9+.-]*:|^#|^//') { continue }
                $relative = $ref.Split('?')[0].Split('#')[0]
                $base = [IO.Path]::GetDirectoryName($file.Relative)
                if ($base) { $relative = Join-Path $base $relative }
                Assert-Resource $Root $relative
            }
        }
        elseif ($file.Relative -match '\.js$') {
            $js = Get-Content -LiteralPath $file.Path -Raw -Encoding UTF8
            foreach ($call in [regex]::Matches($js, '\bimportScripts\s*\(([^)]*)\)')) {
                foreach ($argument in [regex]::Matches($call.Groups[1].Value, '["'']([^"'']+)["'']')) {
                    $relative = $argument.Groups[1].Value
                    if ($relative -match '^[a-z][a-z0-9+.-]*:|^//') { throw 'Remote executable code is not supported by this development sync.' }
                    $base = [IO.Path]::GetDirectoryName($file.Relative)
                    if ($base) { $relative = Join-Path $base $relative }
                    Assert-Resource $Root $relative
                }
            }
        }
        elseif ($file.Relative -match '\.css$') {
            $css = Get-Content -LiteralPath $file.Path -Raw -Encoding UTF8
            foreach ($match in [regex]::Matches($css, '(?:url\(\s*|@import\s+)["'']?([^"'')\s;]+)', 'IgnoreCase')) {
                $ref = $match.Groups[1].Value
                if ($ref -match '^[a-z][a-z0-9+.-]*:|^#|^//') { continue }
                $relative = $ref.Split('?')[0].Split('#')[0]
                $base = [IO.Path]::GetDirectoryName($file.Relative)
                if ($base) { $relative = Join-Path $base $relative }
                Assert-Resource $Root $relative
            }
        }
    }
    return $manifest
}

function Invoke-Git([string[]] $Arguments) {
    $result = @(& git -C $SourceDirectory @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Git '$($Arguments[0])' failed (exit $LASTEXITCODE). Check the checkout and GitHub sign-in; no installation files were changed." }
    return ($result -join "`n").Trim()
}

function Update-Source {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows before using -Pull.' }
    $branch = Invoke-Git @('symbolic-ref', '--quiet', '--short', 'HEAD')
    if ([string]::IsNullOrWhiteSpace($branch)) { throw 'Refusing to pull a detached checkout.' }
    if ($script:ExpectedPullBranch -and $branch -ne $script:ExpectedPullBranch) { throw 'The checkout switched branches while watching. Restart the updater on the intended branch.' }
    $null = Invoke-Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
    if (Invoke-Git @('status', '--porcelain', '--untracked-files=all')) { throw 'The source checkout has local changes. Commit or preserve them before -Pull; nothing was overwritten.' }
    $null = Invoke-Git @('fetch', '--quiet')
    if ((Invoke-Git @('symbolic-ref', '--quiet', '--short', 'HEAD')) -ne $branch -or (Invoke-Git @('status', '--porcelain', '--untracked-files=all'))) {
        throw 'The source changed while fetching. Stop editing and retry; no merge or installation update was performed.'
    }
    $null = Invoke-Git @('merge', '--ff-only', '--quiet', '@{upstream}')
    if ((Invoke-Git @('symbolic-ref', '--quiet', '--short', 'HEAD')) -ne $branch -or (Invoke-Git @('status', '--porcelain', '--untracked-files=all'))) {
        throw 'The checkout is no longer clean on its original branch. Inspect it before syncing.'
    }
    $script:ExpectedPullBranch = $branch
}

function Assert-CleanPullSource {
    $branch = Invoke-Git @('symbolic-ref', '--quiet', '--short', 'HEAD')
    if ($branch -ne $script:ExpectedPullBranch -or (Invoke-Git @('status', '--porcelain', '--untracked-files=all'))) {
        throw 'The source checkout changed or has local edits. No files will be deployed in -Pull mode until the checkout is clean on its original branch.'
    }
}

function Read-SyncState {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { return $null }
    Assert-NoReparsePath $StateFile
    try { $saved = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "Cannot read development state. Preserve and inspect $StateFile before retrying." }
    if ($saved.schema -ne $StateSchema -or $saved.name -ne $ExpectedName -or $saved.install_directory -ne $InstallDirectory) {
        throw "The development state belongs to another installation: $StateFile"
    }
    return $saved
}

function Invoke-Sync {
    $manifest = Get-ValidatedManifest $ExtensionDirectory
    $sourceFiles = @(Get-SafeFiles $ExtensionDirectory)
    if (Test-Path -LiteralPath $InstallDirectory) {
        if (-not (Test-Path -LiteralPath $InstallDirectory -PathType Container)) { throw 'The installation path is not a folder.' }
        $null = Get-SafeFiles $InstallDirectory
        $targetManifest = Join-Path $InstallDirectory 'manifest.json'
        if (Test-Path -LiteralPath $targetManifest -PathType Leaf) {
            try { $installed = Get-Content -LiteralPath $targetManifest -Raw -Encoding UTF8 | ConvertFrom-Json }
            catch { throw 'The installed manifest is invalid. Back up and inspect that folder before syncing.' }
            if ($installed.name -ne $ExpectedName -or $installed.manifest_version -ne 3) { throw 'Refusing to overwrite a different installed extension.' }
        }
        elseif (@(Get-ChildItem -LiteralPath $InstallDirectory -Force).Count -gt 0) {
            throw 'The installation folder has files but no TheCalm Skip manifest. Choose an empty folder or the existing extension installation.'
        }
    }
    $saved = Read-SyncState
    $entries = @()
    $changes = @()
    foreach ($file in $sourceFiles) {
        $hash = (Get-FileHash -LiteralPath $file.Path -Algorithm SHA256).Hash
        $entries += [PSCustomObject] @{ path = $file.Relative; sha256 = $hash }
        $destination = Get-ResourcePath $InstallDirectory $file.Relative
        if ((Test-Path -LiteralPath $destination) -and -not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            throw "A directory conflicts with a managed extension file: $destination"
        }
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $hash) { $changes += $file.Relative }
    }
    $removals = @()
    if ($null -ne $saved) {
        foreach ($entry in $saved.managed_files) {
            if (@($entries.path) -contains $entry.path) { continue }
            $oldPath = Get-ResourcePath $InstallDirectory ([string] $entry.path)
            if (Test-Path -LiteralPath $oldPath -PathType Leaf) {
                if ((Get-FileHash -LiteralPath $oldPath -Algorithm SHA256).Hash -eq $entry.sha256) { $removals += [string] $entry.path }
                else { Write-Warning "Preserved modified retired resource: $($entry.path)" }
            }
        }
    }
    if ($changes.Count -eq 0 -and $removals.Count -eq 0 -and $null -ne $saved) { return $false }

    Assert-NoReparsePath $StateDirectory
    $null = New-Item -ItemType Directory -Path $StateDirectory -Force
    $stage = Join-Path $StateDirectory ('stage-' + [Guid]::NewGuid().ToString('N'))
    $backup = Join-Path (Join-Path $StateDirectory 'backups') ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $written = @()
    $backedUp = @()
    try {
        $null = New-Item -ItemType Directory -Path $stage
        foreach ($file in $sourceFiles) {
            Assert-NoReparsePath $file.Path
            $staged = Get-ResourcePath $stage $file.Relative
            $null = New-Item -ItemType Directory -Path (Split-Path -Parent $staged) -Force
            Copy-Item -LiteralPath $file.Path -Destination $staged
            if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne ($entries | Where-Object { $_.path -eq $file.Relative }).sha256) {
                throw 'A source file changed while being staged. Save your edits, then retry.'
            }
        }
        $null = Get-ValidatedManifest $stage
        foreach ($relative in @($changes) + @($removals)) {
            $destination = Get-ResourcePath $InstallDirectory $relative
            if (Test-Path -LiteralPath $destination -PathType Leaf) {
                $preserved = Get-ResourcePath $backup $relative
                $null = New-Item -ItemType Directory -Path (Split-Path -Parent $preserved) -Force
                Copy-Item -LiteralPath $destination -Destination $preserved
                $backedUp += $relative
            }
        }
        foreach ($relative in $changes) {
            $destination = Get-ResourcePath $InstallDirectory $relative
            $null = New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force
            $written += $relative
            Copy-Item -LiteralPath (Get-ResourcePath $stage $relative) -Destination $destination -Force
        }
        foreach ($relative in $removals) {
            $written += $relative
            Remove-Item -LiteralPath (Get-ResourcePath $InstallDirectory $relative)
        }
        $newState = [ordered] @{ schema = $StateSchema; name = $ExpectedName; install_directory = $InstallDirectory; version = [string] $manifest.version; managed_files = @($entries) }
        $temporaryState = Join-Path $StateDirectory ('state-' + [Guid]::NewGuid().ToString('N') + '.json')
        $newState | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryState -Encoding UTF8
        Move-Item -LiteralPath $temporaryState -Destination $StateFile -Force
    }
    catch {
        $original = $_
        $restoreFailures = New-Object 'System.Collections.Generic.List[string]'
        foreach ($relative in $written) {
            try {
                $destination = Get-ResourcePath $InstallDirectory $relative
                if ($backedUp -contains $relative) { Copy-Item -LiteralPath (Get-ResourcePath $backup $relative) -Destination $destination -Force }
                elseif (Test-Path -LiteralPath $destination -PathType Leaf) { Remove-Item -LiteralPath $destination }
            }
            catch { $restoreFailures.Add([string] $relative) }
        }
        if ($restoreFailures.Count -gt 0) {
            $recovery = if ($backedUp.Count -gt 0) { "Preserved originals are in $backup." } else { 'The affected new files had no previous installed versions.' }
            throw ("Sync failed: {0} Automatic restore was incomplete for: {1}. {2} Other changed files were still restored where possible." -f $original.Exception.Message, ($restoreFailures -join ', '), $recovery)
        }
        throw $original
    }
    finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
    if ($changes.Count -gt 0 -or $removals.Count -gt 0) {
        Write-Host ("Updated TheCalm Skip {0}: {1} changed, {2} retired file(s)." -f $manifest.version, $changes.Count, $removals.Count)
        if ($backedUp.Count -gt 0) { Write-Host "Previous managed files: $backup" }
        Write-Host 'Reload TheCalm Skip in brave://extensions, then reopen your TheCalm/player tabs.'
        return $true
    }
    return $false
}

$SourceDirectory = Get-FullDirectory $SourceDirectory
$InstallDirectory = Get-FullDirectory $InstallDirectory
Assert-NoReparsePath $SourceDirectory
Assert-NoReparsePath $InstallDirectory
if ((Test-Within $InstallDirectory $SourceDirectory) -or (Test-Within $SourceDirectory $InstallDirectory)) {
    throw 'The development source and installed extension must be separate, non-overlapping folders.'
}
$ExtensionDirectory = if (Test-Path -LiteralPath (Join-Path $SourceDirectory 'manifest.json') -PathType Leaf) { $SourceDirectory } else { Join-Path $SourceDirectory 'extension' }
$StateDirectory = Join-Path (Split-Path -Parent $InstallDirectory) ((Split-Path -Leaf $InstallDirectory) + '-dev-sync')
$StateFile = Join-Path $StateDirectory 'state.json'
if ((Test-Within $StateDirectory $SourceDirectory) -or (Test-Within $SourceDirectory $StateDirectory)) { throw 'The backup/state folder must also be outside the development source.' }
Assert-NoReparsePath $StateDirectory
$nextPull = [DateTime]::MinValue
$script:ExpectedPullBranch = $null
$pullReady = -not $Pull
$firstRun = $true
if ($Watch) { Write-Host 'Watching local extension files. Press Ctrl+C to stop. Brave reloads remain manual.' }
do {
    try {
        if ($Pull -and [DateTime]::UtcNow -ge $nextPull) {
            $pullReady = $false
            Update-Source
            $pullReady = $true
            $nextPull = [DateTime]::UtcNow.AddSeconds($PullIntervalSeconds)
        }
        if ($pullReady) {
            if ($Pull) { Assert-CleanPullSource }
            $changed = Invoke-Sync
            if ($firstRun -and -not $changed) { Write-Host 'Installed extension files are already up to date.' }
            $firstRun = $false
        }
    }
    catch {
        if (-not $Watch) { throw }
        Write-Warning $_.Exception.Message
        if ($Pull) { $pullReady = $false; $nextPull = [DateTime]::UtcNow.AddSeconds($PullIntervalSeconds) }
    }
    if ($Watch) { Start-Sleep -Seconds $PollSeconds }
} while ($Watch)
