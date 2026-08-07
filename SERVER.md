# Server- und Deployment-Konventionen

Diese Datei beschreibt, wie kleine Mehrspieler-Browserspiele auf `inf-zeus.de`
gebaut und ausgeliefert werden. Sie ist projektunabhängig: in ein neues Projekt
kopieren, den Abschnitt „Dieses Projekt" unten ausfüllen, fertig.

Wer das hier liest (Mensch oder KI): Die Regeln unter **Pflicht** sind nicht
Geschmackssache. Jede einzelne stammt aus einem Fehler, der auf diesem Server
schon mindestens einmal passiert ist.

---

## Der Server

| | |
|---|---|
| Host | `inf-zeus.de`, Ubuntu, Zugang als `root` |
| Webserver | **Apache 2.4** (nicht nginx – im DocumentRoot liegt eine verwaiste `index.nginx-debian.html`, die in die Irre führt) |
| vHost | `/etc/apache2/sites-enabled/inf-zeus.conf`, der `*:443`-Block ab Zeile 22 |
| TLS | certbot, läuft. Neue Projekte brauchen nichts eigenes. |
| DocumentRoot | `/var/www/html/` – hier liegen die Projektordner nebeneinander |
| Runtime | Deno unter `/usr/local/bin/deno` (2.9.x), systemweit für alle User lesbar |
| Node/PM2 | vorhanden, wird von den älteren Projekten benutzt |
| GitHub | User `gthdtasdnm`. **Der Server hat keinen SSH-Key hinterlegt.** |

### Aufteilung

Jedes Spiel ist ein eigener Prozess auf einem eigenen lokalen Port. Apache
reicht es unter einem Unterpfad durch: `https://inf-zeus.de/<projekt>/`.
Keine Subdomains, keine eigenen vHosts.

### Portvergabe

Vor dem Anlegen eines neuen Projekts **prüfen**, sonst startet der Dienst nicht:

```bash
ss -tlnp | grep <port>     # muss leer sein
ss -tlnp                   # Gesamtübersicht
```

| Port | Projekt | Prozessmanager | Verzeichnis |
|---|---|---|---|
| 3000 | keep | PM2 | `/var/www/html/keep` |
| 8077 | seconds | systemd | `/var/www/html/seconds` |
| 8078 | luckyreflex | systemd | `/var/www/html/luckyreflex` |
| 8090 | cardchaos | PM2 | `/var/www/html/cardchaos` |

Seit 08/2026 liegen alle vier im DocumentRoot und heißen wie ihr URL-Pfad.
Trotzdem gilt: vor jedem Deployment die Wahrheit beim Prozessmanager erfragen,
nicht hier: 

```bash
pm2 describe <projekt> | grep -E "exec cwd|script path"
systemctl show -p WorkingDirectory <projekt>.service
```

Nextcloud und die beiden Tradingbots belegen weitere Ports – immer erst die
Gesamtübersicht ansehen, diese Tabelle ist nur so aktuell wie ihr letzter Edit.

---

## Pflicht: was der Code können muss

Ein Spiel läuft unter einem **Unterpfad**, nicht auf der Domainwurzel. Apache
schneidet das Präfix beim Weiterleiten ab, der Prozess sieht also immer nur
Wurzelpfade. Das heißt für den Code:

**1. Alle Asset-Pfade relativ.** `href="style.css"`, nicht `href="/style.css"`.
Ein führender Slash zeigt auf `inf-zeus.de/style.css` und liefert 404.

**2. Die WebSocket-URL aus dem Basispfad ableiten.** Nie `location.host` mit
festem Pfad verketten – das landet auf `inf-zeus.de/ws` statt
`inf-zeus.de/<projekt>/ws`. Die Lobby lädt dann, aber nichts funktioniert:

```js
const url = new URL("ws", document.baseURI);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(url);
```

Das funktioniert unverändert lokal auf `localhost:8000` und in Produktion unter
`/<projekt>/`. Der Pfad steht an keiner Stelle im Code.

**3. Host über Umgebungsvariable, Default lokal-freundlich.** In Produktion
muss `HOST=127.0.0.1` gesetzt sein, sonst ist der Dienst unter Umgehung von
Apache direkt über `inf-zeus.de:<port>` erreichbar – ohne HTTPS:

```js
const PORT = Number(Deno.env.get("PORT") ?? 8000);
const HOST = Deno.env.get("HOST") ?? "0.0.0.0";
```

**4. Kein Build-Schritt, keine Abhängigkeiten.** Vanilla JS im Browser, Deno auf
dem Server. `git pull` muss als Deployment reichen.

**5. Layout in `dvh` rechnen, nicht in `vh`.** Auf Android zählt `vh` die
eingeblendete URL-Leiste nicht mit; die Seite rechnet mit mehr Höhe als
sichtbar ist und Elemente überlappen. Bei gestapelten Elementen die Größe aus
der **Resthöhe** ableiten, nicht aus einem Bruchteil des Viewports:

```css
/* Falsch: zwei Karten à 40vh = 80vh, plus Topbar und Banner passt das nicht */
.card { width: min(86vw, 40vh); }

/* Richtig: Resthöhe minus gemessenes Beiwerk, geteilt durch die Anzahl */
.card { width: min(86vw, (100dvh - 220px) / 2); }
```

---

## Deployment

### 1. Klonen

**Immer HTTPS, nie SSH** – der Server hat keinen GitHub-Key, `git@github.com:…`
scheitert mit „Please make sure you have the correct access rights":

```bash
git clone https://github.com/gthdtasdnm/<projekt>.git /var/www/html/<projekt>
chown -R www-data:www-data /var/www/html/<projekt>
```

Bricht der Clone ab, bleibt ein leeres Verzeichnis zurück. Vor dem zweiten
Versuch mit `rmdir /var/www/html/<projekt>` entfernen – `rmdir` bricht von
selbst ab, falls doch etwas drin ist.

### 2. Dienst einrichten (systemd)

Für neue Projekte **systemd**, nicht PM2: keine zusätzliche Abhängigkeit,
Autostart ohne `pm2 startup`, Logs über `journalctl`. Keep und Card Chaos
laufen historisch unter PM2 – das bleibt, wird aber nicht fortgeführt.

```bash
cat > /etc/systemd/system/<projekt>.service <<'EOF'
[Unit]
Description=<Projekt>
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/html/<projekt>
ExecStart=/usr/local/bin/deno run --allow-net --allow-read --allow-env --allow-sys server.js
Environment=PORT=<port>
Environment=HOST=127.0.0.1
Environment=DENO_DIR=/tmp/deno-cache
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload && systemctl enable --now <projekt>
systemctl status <projekt>
curl -I http://127.0.0.1:<port>/          # 200 erwartet, bevor Apache dazukommt
```

Zwei Fallen in dieser Unit:

- **`DENO_DIR=/tmp/deno-cache`** ist nicht optional. `www-data` hat `/var/www`
  als Home und darf dort nicht schreiben; Deno will seinen Cache aber genau
  dorthin legen und der Dienst startet nicht.
- **`/usr/local/bin/deno`**, nie `/root/.deno/bin/deno`. `www-data` kommt an
  `/root/` nicht heran, das gibt ein nacktes `status=203/EXEC` ohne Erklärung.
  Prüfen mit `sudo -u www-data /usr/local/bin/deno --version`.

Schreibt das Projekt Daten (Bestenliste o. ä.), gehört `--allow-write` dazu und
das Zielverzeichnis unter `/var/lib/<projekt>/` mit `chown www-data`, nicht ins
DocumentRoot.

### 3. Apache

Als **eigene Datei** unter `conf-available`, nicht in `inf-zeus.conf` hinein
editieren. Das lässt die funktionierende vHost-Config unangetastet und ist mit
`a2disconf` in einer Zeile rückgängig zu machen:

```bash
cat > /etc/apache2/conf-available/<projekt>.conf <<'EOF'
RedirectMatch permanent "^/<projekt>$" "/<projekt>/"

ProxyPass        /<projekt>/ws  ws://127.0.0.1:<port>/ws
ProxyPassReverse /<projekt>/ws  ws://127.0.0.1:<port>/ws

ProxyPass        /<projekt>/    http://127.0.0.1:<port>/
ProxyPassReverse /<projekt>/    http://127.0.0.1:<port>/
EOF

a2enmod proxy proxy_http proxy_wstunnel
a2enconf <projekt>
apache2ctl configtest && systemctl reload apache2
```

Die drei Regeln, in dieser Reihenfolge und aus diesen Gründen:

1. **`proxy_wstunnel` muss aktiv sein.** Fehlt das Modul, bricht die
   WebSocket-Verbindung sofort ab und das Spiel hängt in der Lobby. Der
   häufigste Fehler überhaupt.
2. **Die `/ws`-Regel muss vor der allgemeinen stehen.** Apache nimmt die erste
   passende Regel, nicht die spezifischste. Steht sie hinten, wird der
   Upgrade-Handshake als normales HTTP durchgereicht – gleicher Effekt wie 1.
3. **Der Redirect auf den Schrägstrich muss da sein.** Ohne ihn löst der
   Browser bei `inf-zeus.de/<projekt>` (ohne Slash) `style.css` gegen die
   Domainwurzel auf: Seite ohne CSS und ohne JavaScript.

Enthält `inf-zeus.conf` je eine Catch-all-Regel wie `ProxyPass /`, gewinnt die
vHost-Regel gegen `conf-available` und der Block muss doch in den vHost.
Prüfen mit `grep -n "ProxyPass\|Alias" /etc/apache2/sites-enabled/inf-zeus.conf`.

### 4. Prüfen

```bash
curl -sI https://inf-zeus.de/<projekt>/ | head -1        # HTTP/1.1 200 OK
curl -s  https://inf-zeus.de/<projekt>/style.css | head -1  # CSS, kein HTML
```

Der zweite Test ist der aussagekräftige: kommt HTML zurück, greift die
Proxy-Regel nicht und Apache liefert aus dem DocumentRoot.

Den WebSocket deckt kein `curl`-Test ab. Dafür die Seite auf **zwei Geräten**
öffnen, auf einem einen Raum erstellen, auf dem anderen beitreten. Erscheint
der zweite Name, funktioniert der Upgrade durch den Proxy.

### 5. Update

```bash
cd /var/www/html/<projekt> && git pull && systemctl restart <projekt>
```

Bei reinen Frontend-Änderungen (CSS/JS unter `public/`) reicht `git pull` – die
statischen Dateien werden pro Request von der Platte gelesen und mit
`cache-control: no-cache` ausgeliefert.

---

## Fehlersuche

| Symptom | Ursache |
|---|---|
| `status=203/EXEC` | deno-Pfad für `www-data` nicht lesbar → nach `/usr/local/bin/` |
| Dienst startet, stirbt sofort | fehlendes `DENO_DIR`, Cache-Schreibversuch in `/var/www` |
| Seite ohne CSS/JS | `RedirectMatch` auf den Slash fehlt, oder absolute Asset-Pfade im HTML |
| Lobby lädt, Spiel hängt | WebSocket – `proxy_wstunnel` fehlt, `/ws`-Regel steht hinten, oder die Client-URL ist nicht aus `document.baseURI` gebaut |
| `/<projekt>/style.css` liefert HTML | ProxyPass greift nicht, Apache liefert aus dem DocumentRoot |
| Clone scheitert mit „access rights" | SSH statt HTTPS benutzt |
| Elemente überlappen auf dem Handy | `vh` statt `dvh`, oder Größe nicht aus der Resthöhe gerechnet |

Erste Anlaufstelle bei jedem Dienstproblem:

```bash
journalctl -u <projekt> -n 30 --no-pager
```

---

## Arbeitsweise

**Mehrzeilige Configs immer als Heredoc geben**, also `cat > datei <<'EOF' … EOF`,
nie als Textblock zum Einfügen in `nano`. Ein Apache-Block, der versehentlich
in der Shell landet, quittiert das mit `ProxyPass: command not found` und ändert
nichts – das ist auf diesem Server schon dreimal passiert.

**Layout auf Handygröße prüfen, bevor es live geht.** Auf dem Arbeitsrechner ist
nur Firefox installiert, das reicht:

```bash
firefox --headless --window-size=360,660 --screenshot "$PWD/out.png" "file://$PWD/probe.html"
```

Eine `probe.html` bauen, die das echte Stylesheet lädt und die Spielansicht mit
Beispieldaten zeigt – Animationen dabei abschalten, sonst trifft der Screenshot
Frame 0 und Elemente mit `opacity: 0`-Start fehlen scheinbar.

---

## Dieses Projekt

<!-- Beim Kopieren in ein neues Projekt ausfüllen -->

| | |
|---|---|
| Name | seconds |
| Repo | https://github.com/gthdtasdnm/seconds |
| Pfad auf dem Server | `/var/www/html/seconds` |
| Port | 8077 |
| Prozessmanager | systemd (`seconds.service`) |
| Apache | `/etc/apache2/conf-available/seconds.conf` |
| URL | https://inf-zeus.de/seconds/ |
