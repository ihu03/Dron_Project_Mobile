$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSCommandPath
Set-Location $here

# 서버 포트 설정
$env:PORT = 8080

# 브라우저 먼저 열기 (필요하면 Delay를 추가해도 됩니다)
Start-Process "http://localhost:8080"

# 서버 실행 (창을 닫으면 서버도 함께 종료)
node "$here/server.js"
