' 从项目所在目录静默启动；日志由 background-host.js 保存。
Option Explicit
Dim sh, fso, root, dirs, dir, node, cmd, candidate
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = fso.BuildPath(root, "bridge")
node = ""
dirs = Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
For Each dir In dirs
  dir = Replace(Trim(dir), """", "")
  If dir <> "" Then
    candidate = fso.BuildPath(dir, "node.exe")
    If fso.FileExists(candidate) Then
      node = candidate
      Exit For
    End If
  End If
Next
If node = "" Then
  MsgBox "未找到 Node.js。请安装 Node.js 并确保 node.exe 在 PATH 中。", 16, "CodexWatch"
  WScript.Quit 1
End If
cmd = """" & node & """ """ & fso.BuildPath(root, "bridge\background-host.js") & """"
sh.Run cmd, 0, False
