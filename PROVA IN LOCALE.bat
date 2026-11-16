@echo off
cd /d "%~dp0"
echo Avvio GBA Insieme su http://localhost:8800 ...
echo Per fermarlo chiudi questa finestra.
start "" http://localhost:8800/
python -m http.server 8800 --bind 127.0.0.1
