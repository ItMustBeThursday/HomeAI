function New-HomeAIStageReport($Settings,$Benchmark,$Dependencies,[bool]$GatewayHealthy,$Hardware) {
    $models=@($Benchmark.results | ForEach-Object { $_.model } | Select-Object -Unique)
    $summary=@()
    foreach($model in $models) {
        $results=@($Benchmark.results | Where-Object { $_.model -eq $model })
        $tool=@($results | Where-Object { $_.case -eq 'tool-roundtrip' }) | Select-Object -First 1
        $timed=@($results | Where-Object { $_.PSObject.Properties.Name -contains 'tokensPerSecond' })
        $gpuPath=Join-Path $Settings.root ('evaluations\gpu-'+($model -replace '[^a-zA-Z0-9-]','_')+'.json')
        $gpu=$null
        if(Test-Path -LiteralPath $gpuPath) {
            $data=Get-Content -LiteralPath $gpuPath -Raw | ConvertFrom-Json
            $gpu=@($data.models | Where-Object { $_.name -eq $model }) | Select-Object -First 1
        }
        $summary+=@{
            model=$model;structuredToolCall=($null -ne $tool -and [bool]$tool.validStructuredCall);
            averageTokensPerSecond=[math]::Round(($timed | Measure-Object tokensPerSecond -Average).Average,2);
            gpuBytes=if($gpu) {$gpu.size_vram} else {0};
            quality='Needs human review; no automatic claim of overall quality.'
        }
    }
    return @{
        schemaVersion=1;stage=2;status='checks-run-quality-review-needed';
        generatedAt=(Get-Date).ToUniversalTime().ToString('o');
        gatewayHealthy=$GatewayHealthy;dependencies=$Dependencies;hardware=$Hardware;
        context=$Settings.context;models=$summary;cloudInference=$false;
        runtimeVersions=@{openclaw=$Settings.openclawVersion;node=$Settings.nodeVersion;ollama=$Settings.ollamaVersion};
        completedAutomation=@('dependency checks','gateway health check','saved model benchmark','status report');
        notImplemented=@('full specialist scheduler','policy-controlled PC tools','professional document worker',
            'image backend','voice modes','assistive hardware/control integration');
        next='Review the sample answers. Stage 3 is the next development deliverable, not installed by this script.'
    }
}

function Write-HomeAIStageHtml([string]$Path,$Report,$Benchmark) {
    function Encode($Value) { [Net.WebUtility]::HtmlEncode([string]$Value) }
    $rows=@($Report.models | ForEach-Object {
        '<tr><td>'+(Encode $_.model)+'</td><td>'+(Encode $_.averageTokensPerSecond)+
            '</td><td>'+(Encode $_.structuredToolCall)+'</td><td>'+
            ([math]::Round($_.gpuBytes/1GB,1))+'</td></tr>'
    }) -join ''
    $samples=@($Benchmark.results | Where-Object { $_.case -ne 'tool-roundtrip' } | ForEach-Object {
        '<details><summary>'+(Encode $_.model)+' / '+(Encode $_.case)+'</summary><p><strong>Check:</strong> '+
            (Encode $_.expected)+'</p><pre>'+(Encode $_.answer)+'</pre></details>'
    }) -join ''
    $html=@"
<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HomeAI readiness report</title><style>body{font:17px/1.6 system-ui;margin:32px auto;max-width:920px;padding:0 24px;color:#183440}h1{line-height:1.2}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #cddfe4}details{padding:14px 0;border-bottom:1px solid #cddfe4}pre{white-space:pre-wrap;font:15px/1.6 system-ui}summary{cursor:pointer}aside{background:#e8f4f6;padding:18px}</style>
<h1>Your main-model foundation has been checked.</h1>
<aside>Gateway healthy: $(Encode $Report.gatewayHealthy). Context: $(Encode $Report.context).
These are installation and model checks, not proof that every planned capability exists.</aside>
<h2>Model results</h2><table><thead><tr><th>Model</th><th>Average tokens/sec</th><th>Structured tool call</th><th>GPU GiB</th></tr></thead><tbody>$rows</tbody></table>
<p>Generation speed excludes some loading/prompt overhead. Review the actual answers before deciding on quality.</p>
<h2>Sample answers to review</h2>$samples
<h2>What comes next</h2><ol><li>Approve the main model based on useful answers and acceptable delay.</li><li>Build and install stage 3: restricted tools, document generation and automatic task routing.</li><li>Add an AMD image backend and shared GPU queue.</li><li>Add voice, then separately pilot assistive room controls.</li></ol>
<p>Stages 3-6 remain development and hardware-validation work. This continuation does not silently enable them.</p>
<p>The adjacent next-steps.json contains versions, benchmark summaries and readiness. It contains no API keys, gateway token, project files or copied conversation history.</p></html>
"@
    [IO.File]::WriteAllText($Path,$html,(New-Object Text.UTF8Encoding($false)))
}
