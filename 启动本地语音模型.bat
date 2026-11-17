@echo off
chcp 65001 >nul
title GPT-SoVITS 本地语音服务
cd /d D:\GPT-SoVITS

echo ============================================
echo   GPT-SoVITS 本地语音服务
echo   地址: http://127.0.0.1:9880
echo   关闭此窗口即停止服务
echo ============================================
echo.

rem 若已在运行则提示并退出，避免重复启动抢端口
netstat -ano | findstr ":9880" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [提示] 9880 端口已被占用，服务可能已在运行。
  echo 如需重启，请先关闭正在运行的服务窗口。
  echo.
  pause
  exit /b
)

echo 正在启动（首次加载模型约需 1-3 分钟，请耐心等待）...
echo.
"D:\Python310\python.exe" api_v2.py -a 127.0.0.1 -p 9880

echo.
echo 服务已退出。
pause
