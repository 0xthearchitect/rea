param([string]$Node, [string]$Rea, [string]$Target, [string]$Label = 'warm')
$ErrorActionPreference = 'Stop'
$studioMeasureRoot = Join-Path (Get-Location) ('.local/measure-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
New-Item -ItemType Directory -Path $studioMeasureRoot -Force | Out-Null
$studioStart = New-Object System.Diagnostics.ProcessStartInfo
$studioStart.FileName = $Node
$studioStart.Arguments = '"' + (Join-Path (Get-Location) 'src-tauri/resources/bridge.mjs') + '"'
$studioStart.UseShellExecute = $false
$studioStart.CreateNoWindow = $true
$studioStart.RedirectStandardInput = $true
$studioStart.RedirectStandardOutput = $true
$studioStart.RedirectStandardError = $true
$studioProcess = New-Object System.Diagnostics.Process
$studioProcess.StartInfo = $studioStart
$studioWatch = [System.Diagnostics.Stopwatch]::StartNew()
if (-not $studioProcess.Start()) { throw 'Bridge failed to start' }
$studioIdentity = @{}
$studioCpu = @{}
$studioIdentity[$studioProcess.Id] = $studioProcess.StartTime.ToUniversalTime().Ticks
$studioPeak = 0L
$studioOutTask = $studioProcess.StandardOutput.ReadToEndAsync()
$studioErrTask = $studioProcess.StandardError.ReadToEndAsync()
$studioRequest = @{action='analyze';node=$Node;rea=$Rea;target=$Target;output=(Join-Path $studioMeasureRoot 'evidence.json');projection=(Join-Path $studioMeasureRoot 'projection.json')} | ConvertTo-Json -Compress
$studioProcess.StandardInput.WriteLine($studioRequest)
$studioProcess.StandardInput.Flush()
while (-not $studioProcess.HasExited) {
    $studioProcesses = @(Get-CimInstance Win32_Process)
    for ($studioIteration=0; $studioIteration -lt 4; $studioIteration++) {
        foreach ($studioObserved in $studioProcesses) {
            if ($studioIdentity.ContainsKey([int]$studioObserved.ParentProcessId) -and $studioObserved.CreationDate.ToUniversalTime().Ticks -ge $studioIdentity[[int]$studioObserved.ParentProcessId]) {
                $studioIdentity[[int]$studioObserved.ProcessId] = $studioObserved.CreationDate.ToUniversalTime().Ticks
            }
        }
    }
    $studioCurrent = 0L
    foreach ($studioObserved in $studioProcesses) {
        $studioPid = [int]$studioObserved.ProcessId
        if ($studioIdentity.ContainsKey($studioPid) -and $studioIdentity[$studioPid] -eq $studioObserved.CreationDate.ToUniversalTime().Ticks) {
            $studioCurrent += [long]$studioObserved.WorkingSetSize
            $studioCpu[$studioPid] = ([double]$studioObserved.KernelModeTime + [double]$studioObserved.UserModeTime) / 10000000
        }
    }
    $studioPeak = [Math]::Max($studioPeak, $studioCurrent)
    Start-Sleep -Milliseconds 250
}
$studioWatch.Stop()
$studioOutput = $studioOutTask.GetAwaiter().GetResult()
$studioErrors = $studioErrTask.GetAwaiter().GetResult()
[System.IO.File]::WriteAllText((Join-Path $studioMeasureRoot 'events.jsonl'), $studioOutput)
[System.IO.File]::WriteAllText((Join-Path $studioMeasureRoot 'stderr.log'), $studioErrors)
$studioEvents = @($studioOutput.Trim().Split("`n") | ForEach-Object { $_ | ConvertFrom-Json })
$studioFailure = $studioEvents | Where-Object type -eq 'error'
if ($studioFailure) { throw ($studioFailure.value.message) }
$studioProjection = Get-Content -LiteralPath (Join-Path $studioMeasureRoot 'projection.json') -Raw | ConvertFrom-Json
$studioMetrics = @{label=$Label;elapsed_ms=$studioWatch.ElapsedMilliseconds;cpu_seconds_observed=($studioCpu.Values | Measure-Object -Sum).Sum;peak_family_working_set_bytes_sampled=$studioPeak;sampling='250 ms plus Win32_Process query time; CPU is an observed lower bound; memory is sampled';nodes=$studioProjection.nodes.Count;edges=$studioProjection.edges.Count;raw_evidence_bytes=(Get-Item -LiteralPath (Join-Path $studioMeasureRoot 'evidence.json')).Length;agent_tokens='not measured; no agent workflow';output=$studioMeasureRoot}
$studioMetrics | ConvertTo-Json | Tee-Object -FilePath (Join-Path $studioMeasureRoot 'metrics.json')
