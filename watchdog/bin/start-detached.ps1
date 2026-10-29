param([string]$NodePath, [string]$ScriptPath)

# Create the watchdog process through WMI: its parent becomes WmiPrvSE.exe,
# outside the caller's job object, so killing DSH does not kill the watchdog.
# Note: pass the command line as  "node.exe" "script.mjs"  (no cmd wrapper).
#
# ShowWindow = 0 (SW_HIDE): without it every restart pops a black console
# window on top of the UI and it sits there covering the countdown card.
$cmd = '"' + $NodePath + '" "' + $ScriptPath + '"'
try {
  $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
  $startup.ShowWindow = 0
  $r = ([wmiclass]'Win32_Process').Create($cmd, $null, $startup)
  if ($r.ReturnValue -ne 0) { Write-Error "WMI Create failed: $($r.ReturnValue)"; exit 1 }
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
