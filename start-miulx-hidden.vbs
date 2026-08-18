Option Explicit

Dim shell, fso, projectRoot, cmdPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectRoot = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = fso.BuildPath(projectRoot, "start-miulx-hidden.cmd")
command = "cmd.exe /d /c " & Quote(Quote(cmdPath))
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
