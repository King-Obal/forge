@echo off
cd /d D:\forge\forge-api
java -jar target\forge-api-2.0.12-SNAPSHOT-jar-with-dependencies.jar > logs\api.log 2>&1
pause
