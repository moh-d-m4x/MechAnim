param([string]$Version)

# Update package.json - use simple regex to preserve formatting
$content = Get-Content 'package.json' -Raw
$content = $content -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`""
[System.IO.File]::WriteAllText("$PWD\package.json", $content)

# Update src-tauri/tauri.conf.json - use simple regex
$content = Get-Content 'src-tauri\tauri.conf.json' -Raw
$content = $content -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`""
[System.IO.File]::WriteAllText("$PWD\src-tauri\tauri.conf.json", $content)

# Update src-tauri/Cargo.toml - only the package version line
$lines = Get-Content 'src-tauri\Cargo.toml'
$updated = $false
for ($i = 0; $i -lt $lines.Length; $i++) {
    if (-not $updated -and $lines[$i] -match '^version\s*=') {
        $lines[$i] = "version = `"$Version`""
        $updated = $true
    }
}
$lines | Set-Content 'src-tauri\Cargo.toml'

Write-Host "Version updated to $Version in all config files"
