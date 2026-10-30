Option Explicit
On Error Resume Next
Dim fso, shell, root, q, marker, stream, resultFile, exitCode, runError, command
q = Chr(34)
Set fso = CreateObject("Scripting.FileSystemObject")
If Err.Number <> 0 Then WScript.Quit 70
root = fso.GetParentFolderName(WScript.ScriptFullName)
If Err.Number <> 0 Then WScript.Quit 71
If LCase(fso.GetAbsolutePathName(WScript.ScriptFullName)) <> LCase(fso.GetAbsolutePathName(root & "\Launch-Headless.vbs")) Then WScript.Quit 71
If WScript.Arguments.Count <> 0 Then WScript.Quit 72
marker = root & "\launch-headless.once.json"
Err.Clear
Set stream = fso.CreateTextFile(marker, False, False)
If Err.Number <> 0 Then WScript.Quit 73
stream.WriteLine "{" & q & "schemaVersion" & q & ":" & q & "R07UserHeadlessLaunchRequest.v1" & q & "," & q & "requestedWindowStyle" & q & ":0," & q & "waitOnReturn" & q & ":true}"
stream.Close
If Err.Number <> 0 Then WScript.Quit 74
Set shell = CreateObject("WScript.Shell")
If Err.Number <> 0 Then WScript.Quit 75
command = q & "C:\Users\Lenovo\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" & q & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File " & q & root & "\Start-Headless.ps1" & q
Err.Clear
exitCode = shell.Run(command, 0, True)
runError = Err.Number
If runError <> 0 Then exitCode = 76
Err.Clear
Set resultFile = fso.CreateTextFile(root & "\launch-headless.result.safe.json", False, False)
If Err.Number = 0 Then
 resultFile.WriteLine "{" & q & "schemaVersion" & q & ":" & q & "R07UserHeadlessLaunchResult.v1" & q & "," & q & "runErrorNumber" & q & ":" & CStr(runError) & "," & q & "childExitCode" & q & ":" & CStr(exitCode) & "}"
 resultFile.Close
End If
WScript.Quit exitCode
