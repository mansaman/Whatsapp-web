@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run - installing dependencies, this takes a few minutes...
  call npm install
)
echo Starting WhatsApp Bulk Sender...
call npm start
pause
