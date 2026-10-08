$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$package = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
$source = [IO.File]::ReadAllText((Join-Path $PWD 'src/shared/types.ts'))
$name = [regex]::Match($source, "APP_NAME = '([^']+)'").Groups[1].Value
if ($name -notmatch '^[A-Za-z0-9 _-]+$') { throw 'Invalid application name.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Enable .NET Framework 4.8 on Windows before building portable.' }
$stage = Join-Path $PWD 'build/portable'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$payload = Join-Path $stage 'payload.zip'
if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload }
Compress-Archive -Path 'dist/win-unpacked/*' -DestinationPath $payload -CompressionLevel Optimal
$algorithm = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($payload)
try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $algorithm.Dispose() }
$info = Join-Path $stage 'PortableInfo.cs'
$text = 'internal static class PortableInfo { public const string Name = "' + $name + '"; public const string Version = "' + $package.version + '"; public const string Hash = "' + $hash + '"; }'
[IO.File]::WriteAllText($info, $text)
$output = Join-Path $PWD ('dist\' + $name + '-Portable-' + $package.version + '.exe')
$launcher = Join-Path $PSScriptRoot 'PortableLauncher.cs'
$icon = Join-Path $PWD 'assets\icon.ico'
$payload = $payload.Replace('/', '\')
$info = $info.Replace('/', '\')
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$output" "/win32icon:$icon" /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll "/resource:$payload,timelog.payload.zip" $launcher $info
if ($LASTEXITCODE -ne 0) { throw 'Portable compiler failed.' }
Write-Host ('Portable ready: ' + $output)
