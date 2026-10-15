' CodexWatch Bridge 静默自启(本文件位于启动文件夹时生效)
' 如移动项目目录,请修改下方路径;删除本文件即可取消自启
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\dev\gpt\codexWatch\bridge"
sh.Run "node index.js --port 3599", 0, False
