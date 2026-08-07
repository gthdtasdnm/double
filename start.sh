#!/usr/bin/env sh
# Startet den Seconds-Server (Standard-Port 8000, per PORT=1234 änderbar)
exec deno run --allow-net --allow-read --allow-env --allow-sys "$(dirname "$0")/server.js"
