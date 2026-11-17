@echo off
REM Launches Autumn Sakura without a visible console window.
cd /d "%~dp0"
start "" /B "%~dp0node_modules\.bin\electron.cmd" .
