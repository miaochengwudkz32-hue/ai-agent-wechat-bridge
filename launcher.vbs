' Starts bridge.js in the background (no window) and restarts it if it crashes.
' A normal stop (exit code 0, e.g. "node wake.js --stop") ends the loop.
Option Explicit
Dim sh, fso, root, node, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"

Do
  code = sh.Run("""" & node & """ """ & root & "\bridge.js""", 0, True)
  If code = 0 Then Exit Do
  ' crashed, or another copy is already running (port in use): try again in 30 seconds
  WScript.Sleep 30000
Loop
