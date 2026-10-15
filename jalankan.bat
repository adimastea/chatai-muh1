@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Memasang library, mohon tunggu...
  call npm install
)
npm start
pause
