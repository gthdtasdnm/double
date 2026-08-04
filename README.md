# Double 🎯

Ein Mehrspieler-Browserspiel nach dem Prinzip von *Dobble/Spot it!*:
Deine Karte und die Karte in der Mitte haben **genau ein** gemeinsames Symbol.
Wer es zuerst antippt, bekommt den Punkt.

## Starten

```sh
./start.sh          # oder: deno run --allow-net --allow-read --allow-env --allow-sys server.js
```

Dann `http://localhost:8000` öffnen. Der Server gibt beim Start auch die
Netzwerk-Adresse aus (z. B. `http://192.168.0.163:8000`) – darüber können
Mitspieler aus dem gleichen WLAN mit Handy oder Laptop beitreten.

Anderen Port nutzen: `PORT=3000 ./start.sh`

Voraussetzung: [Deno](https://deno.com) (ist installiert). Keine weiteren
Abhängigkeiten, kein `npm install`.

## Ablauf

1. **Lobby** – Name eingeben, einen Raum erstellen oder einem offenen beitreten.
2. **Warteraum** – Wer den Raum erstellt hat, ist Host. Alle anderen klicken
   auf *Bereit*; erst dann kann der Host die Runde starten (2–4 Spieler).
   Der Host stellt ein, bis wie vielen Punkten gespielt wird (5/10/15).
3. **Runde** – Nach einem Countdown erscheinen Mittelkarte und eigene Karte.
   Das gemeinsame Symbol auf der **eigenen** Karte anklicken.
   Treffer = 1 Punkt und sofort die nächste Runde.
   Fehlklick = 1,5 Sekunden Sperre, die anderen spielen weiter.
4. **Ende** – Wer zuerst die Zielpunktzahl erreicht, gewinnt. Der Host holt
   alle mit einem Klick zurück in den Warteraum.

## Warum es keine Glückskomponente gibt

Das Deck ist eine **endliche projektive Ebene der Ordnung 7**: 57 Karten mit je
8 Symbolen, und je *zwei* Karten teilen sich immer **genau ein** Symbol – nie
mehr, nie weniger. Jede Runde bekommen Mitte und alle Spieler verschiedene
Karten daraus, also hat jede·r garantiert genau eine Übereinstimmung mit der
Mitte und damit dieselbe Gewinnchance. Der Server prüft diese Eigenschaft beim
Start für alle 1 596 Kartenpaare und verweigert sonst den Start.

Schwierig bleibt es durch die Darstellung: Position, Größe (Faktor ~0,7–1,3)
und Drehung (0–360°) jedes Symbols werden pro Karte neu ausgewürfelt, überlappen
aber nie. Auch die Mittelkarte sieht für alle identisch aus – das Layout kommt
vom Server, damit niemand eine leichtere Ansicht bekommt.

## Deployment (Ubuntu-Server hinter Apache)

Läuft als eigener Dienst auf einem lokalen Port; Apache reicht `/double/`
per Reverse Proxy durch. Die Vorlagen liegen in `deploy/`.

```sh
# 1. Klonen und freien Port bestätigen
sudo git clone <repo-url> /var/www/html/double
sudo chown -R www-data:www-data /var/www/html/double
ss -tlnp | grep 8077          # muss leer sein, sonst PORT in der Unit ändern

# 2. Dienst einrichten (deno-Pfad/Port in der Datei prüfen!)
sudo cp /var/www/html/double/deploy/double.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now double
systemctl status double

# 3. Apache: Module aktivieren, Block in den 443-vhost von inf-zeus.de
sudo a2enmod proxy proxy_http proxy_wstunnel
sudo apache2ctl configtest && sudo systemctl reload apache2
```

Der Inhalt für den vhost steht in `deploy/apache-double.conf`. Wichtig sind
zwei Dinge: die WebSocket-Regel muss **vor** der HTTP-Regel stehen, und
`/double` wird auf `/double/` umgeleitet – ohne Slash würden `style.css` und
`app.js` relativ zur Domainwurzel aufgelöst.

Update später: `git pull && sudo systemctl restart double`.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `server.js` | Deck-Erzeugung, Layout, Raum- und Rundenlogik, WebSocket- und Datei-Server |
| `public/index.html` | Die drei Ansichten: Lobby, Warteraum, Spieltisch |
| `public/app.js` | WebSocket-Client, Rendering der Karten, Countdown, Sounds |
| `public/style.css` | Styling, responsives Layout (quer nebeneinander, hoch untereinander) |

Der Server ist autoritativ: Karten, Layouts und die Entscheidung, wer zuerst
geklickt hat, entstehen ausschließlich dort. Clients kennen die Lösung nicht
vorab – sie bekommen nur Symbol-IDs mit Koordinaten.

Kleinigkeiten, die schon eingebaut sind: Seiten-Reload steigt automatisch
wieder in die laufende Partie ein (10 s Karenz bei Verbindungsabbruch), ein
verlassener Raum wird aufgeräumt, und fällt die Spielerzahl mitten im Spiel
unter zwei, geht es zurück in den Warteraum.
