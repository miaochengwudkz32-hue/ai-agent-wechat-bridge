# Takes a screenshot of all monitors and prints the saved PNG path.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File screenshot.ps1 [-Out path.png]
param([string]$Out = "")

$ErrorActionPreference = "Stop"
Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Win32.Dpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
    if (-not $Out) {
        $dir = Join-Path (Split-Path -Parent $PSScriptRoot) "state\media\outbox"
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $Out = Join-Path $dir ("screenshot-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png")
    }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $g.Dispose()
    $bmp.Dispose()
}
Write-Output (Resolve-Path $Out).Path
