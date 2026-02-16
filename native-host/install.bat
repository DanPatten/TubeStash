@echo off
setlocal

set "HOST_DIR=%~dp0"

echo Starting YT Sub host from: %HOST_DIR%
echo.
echo To install permanently, use the installer from the extension's setup page.
echo This script just runs the host directly for development.
echo.

node "%HOST_DIR%host.js"
