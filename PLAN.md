# PyneIDE — Megvalósítási terv

VSCode extension: teljes körű fejlesztőkörnyezet Pine Scripthez és Pyne kódhoz.
Cél: a legjobb Pine Script / trading IDE, később marketplace-publikálással és
bot-indítással.

Stratégiai keret: a rendszer **egyirányú átjáró** — a hosszú távú cél a Pyne
elterjesztése önálló, szabad alternatívaként, nem egy TV-függő "Pine cég".
A Pyne-út (PyneCore + debugger + chart) ezért végig ingyenes és API-kulcs
nélkül is teljes értékű; az előfizetéses Pine-fordítás annak szól, aki két
irányba dolgozik (TV + PyneSys). Az IDE onboardingja ennek megfelelően a
Pyne-élménnyel indít, a Pine-fordítás opcionális belépési pont.

Ez a terv a meglévő kódbázisok tényleges felmérésére épül (PyneAPI, PyneComp,
PyneCore, PineScript.tmbundle, PyCo extension, PyneWasm/EdgePython). A hivatkozott
technikai tények ellenőrzöttek; ahol becslés vagy nyitott kérdés van, jelölöm.

---

## 1. Kiinduló helyzet — mire építünk

| Komponens            | Állapot | Ami van                                                                 |
|----------------------|---------|-------------------------------------------------------------------------|
| PineScript.tmbundle  | kész    | Pine v6 TextMate grammar + VSCode manifest (`package.json`, lang-config) |
| PyneComp             | kész    | Pine v6 -> Python fordító, v4->v5->v6 konverterek, CLI (`pynecomp`)      |
| PyneAPI              | kész    | `POST /compiler/compile` (Bearer API kulcs, előfizetés-gated)            |
| PyneCore             | kész    | `pyne` CLI, `ScriptRunner.run_iter()` beágyazható, per-bar streamelő API |
| PyneWasm + EdgePython| PoC     | Python-subset WASM VM + bundler — hosszú távon a "zárt" Pyne alapja; ma még lassú (~100x CPython), az IDE NEM használja |
| PyCo extension       | kész    | Házon belüli referencia: LSP kliens, DAP debugger, compiler integráció   |
| Sourcemap            | NINCS   | PyneComp nem ad ki mappinget — fejleszteni kell (lásd F6)                |

Kulcs-tények, amikre a terv támaszkodik:

- **Fordítás API-n át:** `POST https://api.pynesys.io/compiler/compile`
  (form-encoded: `script`, `strict`), Bearer token (API kulcs), válasz: nyers
  Python szöveg. Hiba: `{"detail": {"status", "error", "line", "file"}}` —
  csak sorszám van, oszlop nincs. 413 = túl nagy, 429 = limit/lock, 402 = nincs kredit.
  Per-user Redis lock: párhuzamos fordítás 429-et dob.
- **`pyne run`** `.pine`-t magától is fordítja a cloud API-val (`--api-key`),
  kimenetek CSV-ben: plot (`{stem}.csv`), strategy stat (`_strat.csv`),
  trade lista (`_trade.csv`), a `workdir/output/` alá.
- **`ScriptRunner.run_iter()`** (pynecore) generátor: baronként
  `(OHLCV, plot_dict[, új_trade-ek])`-et yieldel — ideális élő chart-streaminghez
  és bar-szintű debughoz. CLI nélkül, importtal használható (`standalone.py` minta).
- **Adat:** `.ohlcv` bináris (24 byte/rekord, mmap) + `.toml` syminfo; letöltés
  `pyne data download` (ccxt beépítve, capitalcom/coinbase/ctrader külön plugin).
- **PyneComp emitter:** kézi, sor-orientált string-emitter (nem `ast.unparse`) —
  a Pine `lineno` minden AST node-on megvan, csak nincs rögzítve kimeneti
  sorokhoz. Sourcemap utólag beépíthető (részletek F6-ban).
- **Névütközés-veszély:** a PyneComp `--strict` flagje mást jelent (Pine-pontos
  blokk-scope-olás), mint a tervezett "zárt" Pyne mód. A zárt módnak más név kell
  (lásd 3.3).

---

## 2. Architektúra-áttekintés

```
┌────────────────────────────── VSCode ──────────────────────────────┐
│  PyneIDE extension (TypeScript)                                    │
│  ├── Nyelvek: pine (tmLanguage), pyne (Python-alapú)               │
│  ├── Parancsok, status bar, walkthrough, API-kulcs kezelés         │
│  ├── Chart webview (KLineChart)  ◄── NDJSON stream / CSV           │
│  ├── DAP: pyne debug (debugpy) + pine debug (DAP-proxy + sourcemap)│
│  └── LSP kliensek: Pine LS, Pyright (+ Pyne-kiegészítés)           │
└──────────┬──────────────────────────────┬──────────────────────────┘
           │                              │
   Python környezet (uv-vel               │ HTTPS
   bootstrapolt venv)                     ▼
   ├── pynecore (runtime + pyne CLI)   PyneAPI (api.pynesys.io)
   ├── runner-bridge (per-bar NDJSON)  └── /compiler/compile (+sourcemap: F6)
   ├── Pine language server (pygls,
   │   pynecomp parserre építve)
   └── debugpy
```

Fő döntés: **a Python-oldali komponensek (runner-bridge, Pine LS, debugpy) mind
ugyanabból a bootstrapolt venv-ből futnak** — egyetlen környezetet kell
menedzselni, és a pynecomp/pynecore verziók együtt frissülnek.

---

## 3. Kulcsdöntések és javaslatok

### 3.1 Python + PyneCore beágyazás: `uv` (elfogadva)

A "hogyan menjen Linux/Mac/Windows alatt" kérdésre a legtisztább válasz ma az
`uv`: egyetlen statikus bináris, ami magát a Pythont is tudja telepíteni,
venv-et készít és csomagot rak bele — nem függ a rendszer Pythonjától.

- Az extension első indításkor letölti a platformnak megfelelő `uv` binárist a
  `globalStorage`-ba (vagy a VSIX-be csomagoljuk platform-specifikus buildekként),
  majd: dedikált venv + `pynecore[all]` + `debugpy` + a saját LS/bridge csomagunk,
  pinnelt verziókkal.
- **Python 3.14** a pinnelt verzió (gyorsabb, és a PyneCore működik vele).
- Minden szint felülbírálható beállításból, aki sajátot akar:
  - `pyneide.pythonPath` — saját Python interpreter;
  - `pyneide.venvPath` — saját virtualenv (az extension ebbe nem telepít,
    csak ellenőrzi, hogy a szükséges csomagok megvannak-e);
  - `pyneide.useOwnPynecore` — a venv-ben már meglévő (pl. editable/fejlesztői)
    PyneCore használata, verzió-pin nélkül, csak minimum-verzió ellenőrzéssel.
- Előny: reprodukálható, gyors, offline-cache-elt; a PyneCore pure Python, zéró
  függőséggel — nincs natív fordítási kockázat.

### 3.2 Nyelv-azonosítók és védjegy

- Extension név: **PyneIDE** (publisher: `pynesys`) — rendben.
- A "Pine Script" a TradingView védjegye, de hivatkozni szabad rá — csak azt
  nem állíthatjuk, hogy a miénk. Tehát a nyelvet nyugodtan hívjuk **Pine
  Script**-nek (language id: `pine`, kiterjesztés: `.pine`), viszont mindenhol
  (Marketplace-leírás, README, extension-oldal) egyértelmű disclaimer:
  "Pine Script is a trademark of TradingView; PyneIDE is not a TradingView
  product and is not affiliated with TradingView."
- Pyne fájlok: sima `.py`, a `@pyne` kezdetű docstring azonosítja (a pynecore
  import hook is pontosan ezt nézi). Az extension NEM vezet be új kiterjesztést —
  a `.py` marad, és a Python nyelvi mód öröklődik; a Pyne-specifikus UI
  (CodeLens, ikon, futtatógomb) a docstring-detektálásra épül.

### 3.3 A "zárt" Pyne mód: **Pyne Edge** (elfogadva)

Név: **Pyne Edge**, jelölés a forrásban: `"""@pyne edge"""` (a `@pyne(\s|$)`
regex-szel kompatibilis). A `strict` szót kerüljük — a PyneComp `--strict` flag
már foglalt (Pine-pontos scope-olást jelent).

- Kifelé az Edge egyszerűen "a hordozható, mindenhol garantáltan futó Pyne
  profil" — azt, hogy a háttérben EdgePython van, nem kell kommunikálni
  (az a rész nem is lesz szabadforrású).
- Az EdgePython/PyneWasm ma PoC állapotú (és egyelőre ~100x lassabb a
  CPythonnál), ezért **az IDE nem használja sem futtatásra, sem validálásra**.
- Az Edge-profil betartatása az IDE-ben: saját linter — (1) importfehérlista
  (csak a PyneCore API), (2) a profilon kívüli nyelvi konstrukciók tiltása.
  A szabálylistát kézzel karbantartott, verziózott definícióként kezeljük
  (forrásanyagnak jó a PyneWasm tapasztalati gap-listája, de az IDE nem függ
  tőle). Ha az EdgePython megérik, a bundler check-módja később beköthető
  végső validálásként.

### 3.4 Chart: KLineChart (megerősítve)

Ellenőrizve: Apache-2.0, TypeScript, zéró függőség, ~40KB gzip, v10.0.0 —
webview-ba beágyazható, framework-független, van custom indicator/overlay API.
Jó választás. A plotok külön pane-ekbe (custom indicator), a strategy trade-ek
overlay markerként, a fill/bgcolor stílusokkal megoldható. A PyneCore-beli
rajzolás (line/label/box) támogatása későbbi PyneCore-feature — a chart-oldal
overlay API-ja készen áll rá.

### 3.5 Debugger-stratégia: debugpy-ra építünk, nem írunk saját DAP-ot

- **Pyne debug:** a generált/kézzel írt Pyne kód normál Python — `debugpy`
  indítja a runnert. Az import hook transzformációi a gyakorlatban megőrzik a
  forráspozíciókat: Pyne script Python debuggerrel már bizonyítottan
  debugolható volt. F4 elején egy rövid smoke-teszt így is jár (breakpoint,
  step, változók több jellegzetes szkripten), de ez megerősítés, nem kockázat.
- **Pine debug:** a lefordított Python fut debugpy alatt, és egy vékony
  **DAP-proxy** (TypeScriptben, az extensionön belül) fordítja oda-vissza a
  forráshivatkozásokat a sourcemap alapján (breakpoint: pine sor -> py sor;
  stack frame: py sor -> pine sor). Ugyanaz a minta, mint a JS/TS sourcemap-elt
  debugging.
- **Bar-szintű vezérlés (mindkét nyelvhez):** a runner-bridge-en keresztül
  "step bar" / "run to bar N" / "pause at bar" műveletek, a `run_iter()`
  generátor természetes megállási pontjain. Ez nem DAP-standard — custom DAP
  requestekkel vagy külön toolbar-parancsokkal (javaslat: utóbbi, egyszerűbb).

### 3.6 Language serverek

- **Pine LS:** saját, Pythonban (`pygls`), a pynecomp lexer/parserére építve —
  a parser már ad `PyneError`-t (sor + üzenet), az AST-ből jönnek a
  document symbols, a builtin-metaadatokból (namespace-ek, szignatúrák) a
  completion/hover/signature help. A venv-ből fut, verzióban együtt mozog a
  fordítóval.
- **Pyne LS:** saját teljes Python-LSP-t továbbra sem írunk, de a sima
  "ajánljuk a Pylance-t" nem elég: a Pyne mint DSL Python-natív, viszont a
  statikus analizátorokat megbolondítja — pl. `Series[float]` átadható sima
  `float`-nak és fordítva, amit egy szabványos checker hibának lát. A terv
  ezért **saját kontrollú Pyright-példány**: a venv-ből futtatjuk a
  `pyright-langserver`-t (vagy basedpyright-ot), és két szinten igazítjuk a
  Pyne-hoz:
  1. **Stub-trükk:** saját `.pyi` stubok a PyneCore API-hoz, ahol típusellenőrzési
     szinten `Series[T]` ≈ `T` (type alias / átlapoló overloadok). Így a
     `Series[float]` <-> `float` átjárás mindkét irányban típushelyes, a kód
     "régi pythonos" marad. Ára: a history-indexelés (`x[1]`) és a
     Series-specifikus műveletek külön stub-kezelést igényelnek — ez a spike
     fő kérdése.
  2. **LSP-proxy diagnosztika-szűrés:** az extension LSP-middleware-rel ül a
     Pyright és a VSCode közé, és a Pyne-fájlokban a mintázatra ismert
     fals pozitívokat eldobja/lefokozza. Ami stubbal nem oldható meg szépen,
     azt itt fogjuk meg.
  - `@pyne` fájlokra a mi példányunk fut; a user Pylance-e nem kötelező
    (ütközés esetén beállítással kizárható a Pyne-fájlokból).
  - F7 legelső lépése egy 1-2 napos spike: mit tud lefedni a stub-trükk
    önmagában — ez dönti el a szűrőréteg méretét.
- Mellé a vékony Pyne-diagnosztika réteg (saját checker a venv-ből):
  Series/Persistent szemantikai szabályok, Edge-profil linting, `@pyne`
  szkript-struktúra ellenőrzés (van-e `main()`, `@script.*` dekorátor).

---

## 4. Fázisok

A fázisok önállóan leszállítható egységek; mindegyik végén működő, kiadható
extension van. Méret: S (napok), M (1-2 hét), L (több hét) — nagyságrendi becslés.

### F0 — Alapozás és nyelvi csomag (S)

Cél: telepíthető extension, ami már hasznos (syntax highlight).

- Repo-struktúra: `package.json`, esbuild bundle, TypeScript, CI (GitHub Actions),
  `vsce` csomagolás. A PyCo extension működő minta (bizonyítottan jó a
  VICE-os debuggere), de nem sablon — minden megoldását érdemben felülvizsgáljuk,
  mielőtt átvesszük.
- Pine grammar átemelése a tmbundle-ből, displayName/védjegy-igazítással (3.2).
- Grammar-frissítés a fordító aktuális állapotához: a pynecomp
  builtin-névterei és kulcsszavai az etalon (a tmbundle a fordító fejlődése
  óta lemaradhatott — diff a `converter/signatures.py` névtér-listájával).
- Pyne oldal: `@pyne` docstring-detektálás, fájl-ikon/badge, nyelvi
  konfiguráció öröklése a Pythontól.
- Kimenet: Marketplace-re is kitehető "Pine + Pyne language support" csomag.

### F1 — Python környezet bootstrap (M)

Cél: az extension önállóan képes PyneCore-t futtatni mindhárom platformon.

- `uv` letöltés/bundle + dedikált venv a `globalStorage`-ban, pinnelt
  `pynecore[all]` + `debugpy` telepítés (3.1).
- Környezet-ellenőrző status bar elem + "PyneIDE: Setup Environment" parancs,
  hibatűrő újratelepítés, proxy-támogatás.
- `pyneide.pythonPath` override haladóknak.
- Workdir-kezelés: a pynecore workdir-felfedezésével kompatibilis logika
  (felfelé keresés), "Create Pyne workspace" parancs (scripts/, data/, config/,
  output/ + demo script).

### F2 — PyneSys fiók és Pine fordítás (M)

Cél: `.pine` fájl fordítása API-n át, hibák a Problems panelben.

- API-kulcs kezelés: `SecretStorage`-ban tárolva, "Sign in" parancs
  (app.pynesys.io-ra irányít, kulcs beillesztése, validálás egy olcsó hívással).
- **Két munkafolyamat, explicit móddal** (fájlonként/projektben választható):
  - **Migrációs mód** (TV -> Pyne áttérés): a `.pine`-t egyszer fordítjuk le,
    az eredmény `.py` lesz az elsődleges forrás, onnantól Pyne-ban folytatódik
    a munka. A generált fájl normál, szerkeszthető kóddá "válik" (nem
    újragenerálódik, felülírás-védelem).
  - **Pine-first mód** (két célpont: TV is, PyneSys is): a `.pine` marad a
    forrás igazsága, a `.py` derivált artifact — minden futtatás előtt
    újrafordul (cache-ből, ha nem változott), kézzel nem szerkesztendő
    (read-only jelölés + figyelmeztetés).
- `Pine: Compile` parancs + compile-on-save opció (Pine-first módban). Debounce
  + a per-user compile-lock (429) kezelése sorbaállítással.
- A hibaválasz (`detail.error`, `detail.line`, `detail.file`) leképezése VSCode
  diagnostics-ra. Oszlop híján teljes sort jelölünk.
- Kvóta-visszajelzés: 429/413/402 emberi nyelven (napi/órás limit, méretlimit,
  kredit), státuszsorban a terv-limit.
- Fordítási cache tartalomhash alapján (az API is cache-el, de a lokális cache
  a rate limitet kíméli).
- A kimenő `.py` elhelyezése: a `.pine` mellé (mint a `pyne run`), gitignore-ajánlással.

### F3 — Futtatás és chart (L) — ez az első "wow" mérföldkő

Cél: egy gombnyomásra fut a script és KLineChart-on látszik az eredmény.

- **Runner-bridge** (Python, a venv-be telepített saját kis csomag):
  `ScriptRunner.run_iter()`-re épül, stdout-on NDJSON-t streamel:
  bar + plot-értékek + új trade-ek eseményenként; végén strategy-összesítő.
  Vezérlő-parancsok stdin-en (pause/resume/cancel) — ez később a bar-stepping
  alapja is.
- Chart webview KLineCharttal: gyertyák + plotok (overlay/külön pane a plot
  jellege szerint), strategy entry/exit markerek, equity-görbe pane.
- Adatválasztó UI: workdir `data/` tartalma + provider-string összeállító
  (`ccxt:BYBIT:BTC/USDT:USDT@1D` minta), `pyne data download` integráció
  progress-szel.
- `Run Pyne Script` / `Run Pine Script` CodeLens és editor-title gomb
  (Pine esetén: fordítás F2 szerint, aztán futtatás).
- Eredmények megnyitása táblázatként is (trade lista, statisztika) — a CSV-k
  már adottak.

### F4 — Pyne debugger (M)

Cél: breakpoint-os debug Pyne kódban.

- `debugpy` launch-konfiguráció: `pyne` runner indítása a venv-ből, workdir és
  adatforrás paraméterezéssel; `justMyCode` alapértelmezetten a user scriptre.
- Import-hook sorszám-megőrzés ellenőrzése (3.5 kockázat); ha csúszik, PyneCore-fix.
- Bar-szintű vezérlés v1: "Run to next bar" / "Run to bar N" a runner-bridge-en
  át + aktuális bar-index/idő a status barban; a chart követi a debug-pozíciót
  (crosshair az aktuális baron).
- Series-barát változat-megjelenítés: a `Series`/`Persistent` értékek olvasható
  reprezentációja a Variables panelben (debugpy variable presentation).

### F5 — Sourcemap a PyneComp-ban + API-kiterjesztés (M, PyneComp/PyneAPI munka)

Cél: megbízható Pine sor <-> generált Python sor mapping.

Ez a fázis nem az extensionben, hanem a fordítóban történik — de az IDE-terv
része, mert a Pine debugger (F6) és a pontos diagnosztika előfeltétele.

- Az emitter instrumentálása: minden statement-kiíráskor rögzíteni
  `(kimeneti_sor, stmt.lineno)`-t. A kézi emitter miatt ez jól kivitelezhető;
  két buktatót kell kezelni:
  - a végső blank-line-összecsukó regexek eltolják a sorokat — a mappinget
    ezután kell korrigálni vagy a collapse-ot mapping-tudatosan végezni;
  - a fix fejléc (docstring, importok, `__all__`, bootstrap) offsetje.
- Formátum: egyszerű JSON (`{"version": 1, "mappings": [[py_sor, pine_sor], ...]}`)
  — teljes sourcemap-spec (VLQ) nem kell, sor-granularitás elég, oszlopot a
  fordító úgysem követ.
- CLI: `pynecomp compile --sourcemap` -> `<stem>.py.map`.
- API: a `POST /compiler/compile` kap egy `sourcemap=true` form-paramétert;
  ilyenkor a válasz JSON `{code, sourcemap}` (a jelenlegi plain-text válasz
  változatlan marad, visszafelé kompatibilisen).
- Bónusz ugyanebből: futásidejű Python-hibák (traceback) visszafordítása Pine
  sorra a Problems panelben / terminálban.

### F6 — Pine debugger (M-L)

Cél: breakpoint, stepping, stack, változók — közvetlenül a `.pine` forrásban.

- DAP-proxy az extensionben: `pine` debug type; belül debugpy-hoz csatlakozik,
  és a sourcemap alapján fordít minden forráshivatkozást (setBreakpoints,
  stackTrace, gotoTargets). Változó-nevek: a fordító átnevezéseit (collision
  rename, scope-suffix) egy név-táblával fordítjuk vissza, amit a sourcemap
  mellé ad ki a fordító (a strict-scope suffixelés miatt enélkül a Variables
  panel olvashatatlan lenne).
- Bar-stepping ugyanúgy működik, mint F4-ben (közös runner-bridge).
- Watch/hover kifejezések: első körben a generált Python néven, később
  Pine-kifejezés -> Python fordítással (nice-to-have).

### F7 — Language serverek (L)

Cél: navigáció, completion, élő hibajelzés mindkét nyelvben.

- **Pine LS** (pygls, a venv-ből): parse-on-change diagnosztika (PyneError sor +
  üzenet), document symbols, folding; completion + hover + signature help a
  builtin-metaadatokból; goto-definition user-szimbólumokra és `import`-olt
  library-kre. A PyCo extension LSP-kliense kiindulási minta lehet, ha a
  felülvizsgálat után jónak bizonyul.
- **Pyne oldal:** Pyright/Pylance ajánlása/aktiválása + saját Pyne-checker
  diagnosztika-forrás (script-struktúra, Series-szabályok).
- Ide tartozik a Pine snippet-készlet is (indicator/strategy váz, gyakori
  ta.* minták).

### F8 — Pyne Edge mód (M)

Cél: a zárt, weben/tőzsdéken garantáltan futó profil kényelmes használata.

- `@pyne edge` jelölés felismerése; külön badge/ikon és színjelzés, hogy
  látszódjon: ez Edge-szkript.
- Edge-linter: importfehérlista (csak PyneCore API), a profilon kívüli
  konstrukciók jelzése — kézzel karbantartott, verziózott szabálylista alapján
  (3.3). Futtatás normál CPython/PyneCore alatt történik, mint minden más
  Pyne-szkriptnél.
- EdgePython-integráció (bundler-check, EdgePython alatti differenciális
  futtatás) tudatosan NEM része ennek a fázisnak — akkor kerül elő, ha az
  EdgePython kinő a PoC-státuszból.

### F9 — Adat- és workspace-menedzsment UI (M)

Cél: az adatkezelés ne CLI-élmény legyen.

- Tree view: workdir tartalma (scripts, data, output) + adat-metaadatok
  (symbol, timeframe, tartomány — a `.toml` syminfóból és az `.ohlcv` fejlécből).
- Letöltés-varázsló (provider, symbol, TF, dátumtartomány), frissítés gomb,
  truncate.
- `.ohlcv` gyors-előnézet: megnyitásra mini-chart / táblázat.
- Input-UI: a script `input.*` hívásainak felismerése és form-alapú
  szerkesztése futtatás előtt (a `pyne run` inputs-mechanizmusára kötve).

### F10 — Polírozás és publikálás (M)

- Walkthrough (első lépések: környezet, API-kulcs, első futtatás).
- Telemetria-mentes hibariport (opcionális), logcsatorna.
- Marketplace + Open VSX publikálás, README/képek/demó GIF.
- Verziókezelési séma: az extension pinnelt pynecore/pynecomp verziókkal
  jelenik meg; a venv-frissítés extension-update-hez kötött.

### F11 — Jövőbeli irányok (a terven túl)

- Egygombos publikálás PyneSys marketplace-re (ha a backend-oldala megvan).
- Bot/live indítás az IDE-ből: a pynecore live mode (`--live`, brókerek) UI-ja —
  a broker-pluginok már léteznek, ez főleg UX-munka + biztonsági megfontolások.
- Bar replay a charton (a replay provider már létezik a pynecore-ban).
- TradingView-összehasonlító nézet (házon belüli tv-api eszközökre építve —
  csak belső használatra, a publikus extensionbe nem való).
- PyneWeb/pyneapp szinergia: a chart-webview és a web-app chartkódjának
  megosztása.

---

## 5. Javasolt MVP-vágás

Az F0-F4 együtt adja ki az első igazán demózható terméket:
syntax highlight + fordítás + futtatás charttal + Pyne debug. A Pine debug (F5+F6)
a legnagyobb differenciátor a piacon ("Pine Scriptet debuggolni sehol máshol nem
lehet"), érdemes közvetlenül az MVP után hozni.

Kiadási stratégia (javaslat, döntés a usernél): az MVP menjen ki korán, de
**csendben** — Marketplace-en elérhető, 0.x verzió, "preview" jelöléssel,
marketing nélkül. Így korai visszajelzés és értékelések gyűlnek, a név és a
niche foglalt. A hangos launch (közösségi posztok, "az első Pine Script
debugger" üzenet) a Pine debugger (F6) megjelenéséhez időzítve — az egyszeri
robbanás-pillanatot arra tartogatjuk.

Sorrendi függések:

```
F0 ──► F1 ──► F2 ──► F3 ──► F4
              │             │
              └─► F5 ───────┴─► F6
F1 ──► F7 (Pine LS a venv-ből)
F1 ──► F8 (PyneWasm a venv-ből)
F3 ──► F9
```

---

## 6. Kockázatok és nyitott kérdések

| Kockázat / kérdés                                                | Kezelés                                                              |
|------------------------------------------------------------------|----------------------------------------------------------------------|
| Sourcemap-pontosság a blank-line collapse miatt                   | Mapping-tudatos collapse vagy utólagos korrekció + teszt-korpusz      |
| Fordítói átnevezések (collision rename) a Variables panelben      | Név-tábla a sourcemap mellé (F6)                                      |
| API rate limit fejlesztés közben (compile-on-save)                | Lokális cache + debounce + Pine-first/migrációs mód szétválasztás     |
| Windows-támogatás (venv, path-ok, debugpy)                        | CI-ben mindhárom OS-en smoke-teszt F1-től kezdve                       |
| KLineChart nagy adatmennyiség (100k+ bar + sok plot)              | Lazy load / windowing a webview-ban; korai teljesítmény-teszt F3-ban  |
| "Pine Script" védjegy                                             | Szabadon hivatkozunk rá, de mindenütt disclaimer: nem TradingView-termék |
| Offline fordítás igénye (API-only a Pine út)                      | Tudatos üzleti döntés: az előfizetés a bevételi modell; lokális fordító csak sokkal később, ha lesz más bevételi ág |
| `Series[T]` <-> `T` átjárás vs statikus analizátorok              | Saját Pyright-példány + stub-trükk + LSP-proxy szűrés; spike F7 elején (3.6) |
| Licenc / szabadforrásúság                                         | Döntés függőben; alapelv: zártan indulni könnyű később nyitni, fordítva nem megy |

---

## 7. Repo-felépítés (javaslat)

```
PyneIDE/
├── package.json              # extension manifest
├── src/                      # TypeScript: aktiválás, parancsok, DAP-proxy, LSP-kliensek
│   ├── extension.ts
│   ├── env/                  # uv/venv bootstrap
│   ├── compile/              # PyneAPI kliens + diagnosztika
│   ├── run/                  # runner-bridge kliens, NDJSON feldolgozás
│   ├── debug/                # debugpy launch + pine DAP-proxy
│   ├── chart/                # webview host
│   └── lsp/
├── webview/                  # KLineChart alapú chart UI (külön bundle)
├── python/                   # a venv-be települő saját csomag: runner-bridge,
│   └── pyneide_support/      # Pine LS (pygls), Pyne/Edge checkerek
├── syntaxes/                 # pine.tmLanguage.json (a tmbundle-ből, frissítve)
├── icons/
└── test/
```

A `python/pyneide_support` külön PyPI-csomagként is kiadható (`pyneide-support`),
így a venv-bootstrap sima `uv pip install` marad.
