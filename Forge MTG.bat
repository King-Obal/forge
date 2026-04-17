@echo off
title Forge MTG - Demarrage...

:: Tuer les instances precedentes
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM java.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

:: Lancer Electron directement - il demarre l'API et affiche l'ecran de chargement
set ELECTRON_RUN_AS_NODE=
start "" "D:\forge\forge-electron\node_modules\electron\dist\electron.exe" "D:\forge\forge-electron"
