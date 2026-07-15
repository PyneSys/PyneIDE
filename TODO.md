# PyneIDE — TODO

Állapotkövetés a `PLAN.md` fázisaihoz. Jelölés: `[ ]` nyitott, `[x]` kész,
`[-]` kihagyva/elhalasztva. Az aktuális fázis részletes; a későbbiek csak
mérföldkő-szinten vannak felbontva, a fázis megkezdésekor bontjuk ki őket.

**Aktuális fázis: F6 kész (2026-07-15, EDH-ben ellenőrizve)** —
Pine debugger a sourcemapre építve: breakpoint/stackTrace/stepping közvetlenül
a `.pine`-ban (DAP-proxy fordítás), Pine-statement granularitású lépkedés,
fordítói átnevezések visszafejtése a Variables/Watch-ban. Élőben ellenőrizve
strict és normál fordítással, v5-konverzióval is. Következő: F7 vagy publikálási
előkészület — a hangos launch a PLAN szerint az F6-hoz időzítve.

---

## F0 — Alapozás és nyelvi csomag (S)

Cél: telepíthető extension, ami már hasznos (syntax highlight).

- [x] Repo-struktúra
  - [x] `package.json` extension manifest (name: pyneide, publisher: pynesys)
  - [x] TypeScript + esbuild bundle (`src/extension.ts` -> `dist/extension.js`)
  - [x] `.gitignore`, `.vscodeignore`, `git init`
  - [x] CI: GitHub Actions (build + typecheck + grammar-teszt + `vsce package`)
  - [x] README a védjegy-disclaimerrel (3.2)
- [x] Pine nyelvi csomag
  - [x] Grammar átemelése a tmbundle-ből (`syntaxes/pine.tmLanguage.json`)
  - [x] Grammar-frissítés: builtin névterek a pynecomp `renames.py`
        `builtin_libraries` + `signatures.py` uniója alapján (pótolva:
        strategy, request, splits, barmerge, polyline, text, earnings, extend,
        font, position, ticker, footprint, volume_row; fix: `=>` nem esik
        szét `=` + `>` tokenekre)
  - [x] Builtin változók frissítése (`renames.py` `builtin_vars`: + bid, ask,
        time_tradingday, dayofmonth, hour, minute, ...)
  - [x] `language-configuration.json` átemelés + Pine-hoz igazítás
        (offside folding, indentálás `=>` / blokk-kulcsszavakra, kapcsos
        zárójel eltávolítva)
  - [x] Fájl-ikon a `.pine` fájlokhoz (SVG; Marketplace PNG ikon F10-re marad)
- [x] Pyne oldal
  - [x] `@pyne` docstring-detektálás (a pynecore `import_hook.py`
        `_PYNE_HEAD_RE` tükrözése: kommentek átugrása, bármely idézőjel)
  - [x] Fájl-badge a Pyne `.py` fájlokra ("Py", FileDecorationProvider)
  - [x] Pyne Edge (`@pyne edge`) badge: "PE" (előkészítés F8-hoz)
- [x] Ellenőrzés
  - [x] Grammar-teszt snapshotokkal (`example.pine` + `namespaces.pine`,
        vscode-tmgrammar-snap)
  - [x] `vsce package` lefut, VSIX telepítve (`pynesys.pyneide@0.0.1`);
        vizuális ellenőrzés (highlight + badge) a felhasználóra vár
- [x] TOML-támogatás (terven kívüli bővítés, 2026-07-12; a Pyne sok TOML-t
      használ: api.toml, syminfo .toml, configok — a VSCode-ban nincs beépített
      TOML-nyelv)
  - [x] Beépített önálló `source.toml` TextMate grammar
        (`syntaxes/toml.tmLanguage.json`) + `language-configuration-toml.json`,
        highlight-only (nincs séma/formázás), grammar-snapshot teszttel
  - [x] Nyelv-regisztráció a package.json-ban (`.toml` + gyakori lockfile-nevek)
  - [x] Puha ajánlás: `tamasfe.even-better-toml` a `.vscode/extensions.json`-ba
        projekt-inicializáláskor (NINCS kötelező függőség — offline/légrés-barát)
- [x] Kimenet: "Pine + Pyne language support" csomag (Marketplace-re még nem
      publikáljuk — a kiadási stratégia szerint az MVP után, csendben)

F0 nyitott apróságok:
- [x] Licenc-döntés: GPL-3.0-only (`LICENSE` fájl, `--skip-license` kivéve a
      CI-ból és a csomagolásból)
- [x] `repository.url` a package.json-ban: github.com/PyneSys/PyneIDE
      (privát repó létrehozva, `main` felpusholva)
- [ ] Vizuális smoke-teszt VSCode-ban (Pine highlight, Pyne badge)

## F1 — Python környezet bootstrap (M)

- [x] `uv` beszerzés
  - [x] Platform-triple felismerés (darwin/linux/win, x64/arm64), letöltés a
        GitHub release-ből a `globalStorage/uv` alá, pinnelt verzió (0.11.28)
  - [x] Beégetett SHA-256 ellenőrzés letöltés után (supply-chain védelem)
  - [x] Kicsomagolás `tar`-ral (macOS/Linux: tar.gz; Windows 10+: beépített
        bsdtar kezeli a zipet is)
  - [x] Proxy: a letöltés `node:https`-en (VSCode proxy-patch érvényesül),
        az uv-spawnok a `http.proxy` beállítást env-ként kapják
- [x] Menedzselt venv a `globalStorage`-ban
  - [x] `uv venv --python 3.14` (UV_PYTHON_INSTALL_DIR a globalStorage alatt,
        önálló, rendszertől független Python)
  - [x] Pinnelt `pynesys-pynecore[all]==6.5.7` + `debugpy==1.8.21` telepítés
  - [x] `env.json` marker (pinnelt verziók); eltérésnél újratelepítés-ajánlat
  - [x] Verifikáció: venv-python importteszt (pynecore + debugpy verzióval)
- [x] Környezet-UI
  - [x] Status bar elem (állapot: setup kell / folyamatban / kész / hiba),
        kattintásra quickpick menü
  - [x] `PyneIDE: Setup Environment` parancs (withProgress, hibatűrő
        újratelepítés: venv törlés + újraépítés)
  - [x] Output channel ("PyneIDE Environment") minden lépés logjával
  - [x] Első aktiváláskor rákérdezés (nem töltünk le csendben)
- [x] Override-ok (machine-szkópú beállítások)
  - [x] `pyneide.pythonPath` — saját interpreter, csak csomag-ellenőrzés
  - [x] `pyneide.venvPath` — saját venv, az extension nem telepít bele
  - [x] `pyneide.useOwnPynecore` — pin helyett csak minimum-verzió ellenőrzés
- [x] Workdir-kezelés (az onboarding 2026-07-12-én átdolgozva)
  - [x] `findWorkdir()` a pynecore `AppState._find_workdir` tükrözése
        (felfelé keresés max 10 szint, `workdir` nevű mappa)
  - [x] `PyneIDE: Initialize Pyne Project` parancs (id: `pyneide.createWorkspace`):
        quickpick "ebbe a mappába" (alap; `pyneide.workdir: "."` marker írása) /
        "workdir/ almappa" (pyne CLI-elrendezés); nyitott-mappa nélküli flow is
  - [x] Scaffold delegálása a pynecore CLI-nek (`scaffoldWorkdirWithCli`,
        nincs kézi másolat — a pynecore az egyetlen forrás); a demót és a
        konfigokat a `pyne` bináris hozza létre
  - [x] `onStartupFinished` aktiválás (status bar üres workspace-ben is látszik)
- [x] CI smoke-teszt job mindhárom OS-en (ubuntu/macos/windows matrix: uv
      letöltés, venv, pinnelt csomagok, importteszt VSCode nélkül); lokálisan
      macOS-en lefutott ("SMOKE OK"), a GitHub Actions futás push után derül ki

## F2 — PyneSys fiók és Pine fordítás (M)

- [x] API-kliens (TS, `node:https` — proxy-kompatibilis; a pynecore
      `pynesys/api.py` kliens szerződését tükrözi: form-encoded compile,
      `detail:{status,error,line,file}` hibaformátum)
- [x] API-kulcs kezelés
  - [x] SecretStorage-tárolás, `PyneSys: Sign In` / `Sign Out` parancsok
  - [x] Validálás olcsó hívással (`/auth/verify-token`), lejárat-info
        (lokális JWT-dekódolás, mint a CLI `verify_token_local`)
  - [x] CLI-interop: `workdir/config/api.toml` kulcs felajánlása importra
- [x] Egyszerű fordítási modell (egyszerűsítve 2026-07-12, a korábbi
      migration/Pine-first módválasztó kivezetve): a `.pine` futtatása mindig
      háttérben fordít, a `.py` mellette landol és szabadon szerkeszthető;
      egyetlen védelem a hash-alapú felülírás-védelem (kézzel szerkesztett
      `.py`-ra rákérdez fordítás előtt)
- [x] `Pine: Compile` parancs (soros fordítási sor, compile-lock 429
      újrapróbálás)
- [x] Hibaválasz -> VSCode diagnostics (sor-szintű, teljes sor jelölve)
- [x] Kvóta-visszajelzés: 429/413/402/401 emberi nyelven + `Show API Usage`
      parancs (napi/órás limit, reset-idő)
- [x] Lokális fordítási cache (tartalomhash + strict flag; kíméli a kvótát)

F2 nyitott: élő végpont-teszt valódi API-kulccsal (Sign In -> Compile ->
diagnostics) a felhasználóra vár; a kliens-szerződés curl-lel ellenőrizve.

## F3 — Futtatás és chart (L) — első "wow" mérföldkő

- [x] Workdir-feloldási lánc (elfogadva 2026-07-10, implementálva 2026-07-12):
      `pyneide.workdir` resource-szkópú beállítás > felfelé keresés a script
      mappájától > felfelé keresés a workspace foldertől > `<ws>/workdir`
      fallback. Tiszta `resolveWorkdir()` (src/env/workdir.ts) + vscode-kötött
      `resolveWorkspaceWorkdir()` (src/env/workdirConfig.ts); `PYNE_WORK_DIR`
      injektálva az integrált terminálba (`environmentVariableCollection`).
- [x] Runner-bridge Python-csomag (implementálva 2026-07-12):
      `python/pyneide_bridge/` az extensionben (nem pip-csomag; PYTHONPATH-on
      fut a venv Pythonjával). NDJSON események a védett stdout-on (fd-hijack:
      user print/pynecore log stderr-re megy), stdin vezérlés
      (pause/resume/step/cancel — a bar-stepping alapja F4-hez). TS kliens:
      `src/run/bridgeClient.ts`; smoke: `test:env` bridge round-trippel.
- [x] Chart webview KLineCharttal (implementálva 2026-07-12): v10 dataLoader
      modell + throttled `resetData()` (adaptív tick), gyertyák + VOL, plotok
      (overlay/pane heurisztika — a pynecore plot() nem ad stílus-metaadatot),
      strategy entry/exit annotációk, equity pane. Chrome-ban vizuálisan
      tesztelve stream-replay-jel.
- [x] Adatválasztó UI + `pyne data download` integráció (implementálva
      2026-07-12): quickpick a workdir `data/` .ohlcv fájljaiból (syminfo
      leírással, utolsó választás megjegyezve scriptenként) + "Download new
      data…" provider-stringgel, progress + output channel.
- [x] Run CodeLens / editor-title gomb (implementálva 2026-07-12):
      `pyneide.runScript` parancs, CodeLens + editor-title/run gomb
      (`pyneide.isPyneScript` kontext-kulcs @pyne detektálással), Pine esetén
      háttérfordítás előbb (cache-találatnál API-hívás nélkül; kézzel
      szerkesztett .py-t csak rákérdezés után ír felül).
      Feloldhatatlan workdirnél egykattintásos "Initialize Project"
      prompt — sosem némán adoptálunk mappát.
- [x] Trade lista / statisztika táblázat-nézet (implementálva 2026-07-12): a
      chart webview alján összecsukható Trades/Stats tabok; trade-sorra
      kattintva a chart az entry pontra ugrik. Auto-expand futás végén.
- [x] Teljesítmény-teszt: 100k+ bar a webview-ban (2026-07-12): 120k bar +
      3 plot + equity + VOL szintetikus stream: teljes feldolgozás + render
      123 ms Chrome-ban — windowing nem kell.

F3 élő végpont-teszt (2026-07-12, felhasználó, EDH): Run gomb -> adatválasztó
-> chart streaming OK a demo adatokkal. Közben javítva: `pyneDetect.ts` a
többsoros docstringet (`"""` + újsor + `@pyne`) nem ismerte fel — a regex a
pynecore `_PYNE_HEAD_RE`-hez igazítva (`\s*` a nyitó idézőjel után).

## F4 — Pyne debugger (M)

- [x] debugpy launch-konfiguráció (implementálva 2026-07-13): saját `pyne`
      debug type, ms-python függőség NÉLKÜL — a bridge `--debugpy-port`-tal
      debugpy listenert indít és megvárja a csatlakozást a script importja
      előtt; az extension `DebugAdapterServer`-rel közvetlenül a listenerre
      köt (a debugpy maga a DAP-szerver). Launch.json támogatás (`script`,
      `data`, `justMyCode` propertyk) + Debug CodeLens/editor-title gomb;
      "Run Without Debugging" sima runra esik vissza. `pyneide.debug.justMyCode`
      beállítás; a bridge-csomag `rules` kizárással kimarad a step-útvonalból.
- [x] Import-hook sorszám-megőrzés smoke-teszt (2026-07-13, v2): headless
      DAP-kliens a `test:env`-ben — saját `dbgvars.py` (Persistent + Series),
      breakpoint az `avg = ...` soron, megállás pont ott, `smooth` local
      látható, pine_slots névfeloldás + slot-evaluate OK, futás végigmegy.
- [x] Bar-szintű vezérlés v2 (2026-07-13, EDH-visszajelzés után): Next Bar /
      Run to Bar… a DEBUG TOOLBARON (`debug/toolBar` menü, debugType == pyne);
      breakpointon állva is működnek (feed-pause felhúzás + DAP continue;
      run-to-bar közben a közbülső breakpoint-megállások auto-continue-t
      kapnak a célbarig). Chart-toolbar Pause/Next bar gombok TÖRÖLVE (nem
      chart-funkció), a folyamatosan pörgő progress-notification TÖRÖLVE
      (status bar elem marad: bar-számláló + vezérlőmenü). Debug módban
      baronkénti flush (batchSize=1).
- [x] Változó-megjelenítés v2 (2026-07-13): DAP-proxy
      (`src/debug/dapProxy.ts`, DebugAdapterInlineImplementation) a VSCode és
      a debugpy közé — a Locals scope-ba beinjektálja a NEVESÍTETT
      Persistent/Series változókat (a `pyneide_bridge/debug_inspect.py`
      `pine_slots` helper a stopped frame-ben, `__pyne_slot_layout__` names
      alapján oldja fel a slotokat; evaluate-tel jön az érték + expand-ref).
      `variablePresentation: {all: group}` alapértelmezés: function/class/
      dunder zaj összecsukott csoportokba. A pydevd SeriesImpl-plugin
      (`python/pydevd_plugins/`) marad a bufferek renderelésére.
- [x] ! PyneCore transzformer sorszám-hiba JAVÍTVA (2026-07-13, KÜLSŐ repo:
      pynecore, commit még nincs): két megnyilvánulása volt. (1) A hely
      nélkül épített node-okra a `fix_missing_locations` a szülő FunctionDef
      teljes tartományát örökítette -> a prológus bytecode egy része az
      UTOLSÓ sorra képződött le (utolsó sori breakpoint minden bar elején,
      korábban állt meg). (2) A `FunctionIsolationTransformer._copy_callee`
      `ast.parse`-szal épített callee-másolata `lineno=1`-et hordozott -> a
      lazy `__resolve_slot__` ág (csak bar 0!) közepén line-1 esemény:
      dupla breakpoint-találat + nemlétező sorra ugró Step Over.
      Javítás: `_copy_callee` `ast.copy_location`-nel bélyegez + új
      `transformers/locations.py` `fix_locations()` (pont-horgonyos
      fix_missing_locations-csere az import_hookban és a két pipeline-
      közbeni hívónál). A managed venv 6.5.7-je kézzel bepatchelve a
      teszthez — pynecore release után törölhető a patch.
      Diagnózis: `PYNE_AST_DEBUG_RAW=1` + `dis.get_instructions(main.__code__)`.

## F5 — Sourcemap a PyneComp-ban + API-kiterjesztés (M, külső repo)

- [x] Emitter instrumentálás (implementálva 2026-07-15, PyneComp repo): NEM
      offszet-könyveléssel, hanem inline marker kommenttel — minden statement
      első kimeneti sorának végére `#__pyne=N__` kerül, amit a végső
      összeállítás UTÁN nyerünk ki és sztrippelünk. Így a marker a sorával
      együtt utazik minden bufferen és utófeldolgozáson át; a kimenet
      bájtazonos a sima fordítással (korpusz-teszt garantálja).
      Új API: `Compiler.compile_str_with_sourcemap()` -> `(code, map)`.
- [x] Blank-line collapse mapping-korrekció: a marker-megközelítéssel
      magától adódik (a markerek sorvégiek, nem változtatnak sorszerkezetet;
      a kinyerés a collapse-ok után fut)
- [x] `pynecomp compile --sourcemap` (`-m`) -> `<stem>.py.map`
      (JSON: `{"version":1,"pine_version":N,"mappings":[[py,pine],...]}`,
      1-indexelt, statementenként az első sor; köztes sorok = forward-fill).
      Csak fájl-kimenettel; pytest: `pynecomp/tests/test_sourcemap.py`.
      Korlát: v4/v5 forrásnál a pine-sorok a KONVERTÁLT v6 forrásra mutatnak.
- [x] API: `sourcemap=true` form-param a `POST /compiler/compile`-on ->
      `{code, sourcemap}` JSON (nélküle plain-text, változatlan). DB-cache
      találatnál helyi újrafordítás adja a konzisztens (code, map) párost.
      Élő végpont-teszt (pyneapi-dev) még hátravan.
- [x] Runtime traceback -> Pine sor visszafordítás (PyneIDE): fordításkor a
      `.py.map` a `.py` mellé kerül (py_sha256-tal; kézzel szerkesztett .py
      érvényteleníti), a bridge error-traceback frame-jei Pine sorra
      fordulnak a Run logban, a legmélyebb frame a Problems panelre és a
      hibaüzenetbe is kerül (`src/compile/sourcemap.ts`). EDH-teszt hátravan.

## F5b — v4/v5 -> v6 konverzió az IDE-ben (S) — az F5 v4/v5 korlát feloldása

Az F5 sourcemap-korlátja (v4/v5-nél a pine-sorok a konvertált v6-ra
mutatnak) nem az API-térkép-szerződésben oldódik meg, hanem IDE oldalon:
a fájl maga válik v6-tá, így egyetlen `python <-> v6` leképezés marad,
és az a v6 az, amit a felhasználó szerkeszt és debugol. Implementálva
2026-07-15 (EDH/élő teszt hátravan; `npm run check` + build zöld):

- [x] In-place konverzió (`CompileService.convertActiveToV6`): a `.pine`
      felülírása v6-tal `WorkspaceEdit`-tel (full-range replace + save), így a
      szerkesztő Undo visszaadja. Nincs külön `*.v6.pine`. Verzió-parser:
      `src/pineVersion.ts` (`//@version=N`). <4 / verzió nélkül: hibaüzenet,
      nincs auto-konverzió (a lánc csak v4/v5-öt tud).
- [x] Kapuzás CSAK a debugon: `runService.resolveDebugLaunch` a `noDebug` ág
      után modalt mutat (Convert to v6 / Cancel), Cancel/elutasítás -> a debug
      megszakad. A sima futtatás/fordítás v4/v5-re változatlanul megy.
- [x] Konverzió az API `POST /compiler/v4tov5` + `/compiler/v5tov6` láncán
      (`PyneApiClient.convertToV6`; kvótát NEM fogyaszt). Sikeres v4/v5
      fordítás után nem-blokkoló info-hint „Convert to v6 is free" gombbal.
      Önálló parancs: `pyneide.convertToV6`.
- [x] `converted_source: true` a `.py.map`-ben v4/v5 forrásnál
      (`StoredSourcemap`); `loadSourcemapFor` ilyenkor `undefined`-et ad ->
      nincs félrevezető traceback-visszafordítás az eredeti fájlra.

## F6 — Pine debugger (M-L)

- [x] Sourcemap-fordítás a DAP-proxyban (nem külön `pine` debug type: a meglévő
      `pyne` session kap `pineSource`-t, ha `.pine`-ból indul; a factory ebből
      épít `PineSourceMapper`-t — `src/debug/sourceMapper.ts`). Irányok:
      setBreakpoints `.pine` -> `.py` (nem-emittáló sorról előre-snappelés; nem
      leképezhető breakpoint unverified-ként megy vissza, a DAP sorrend tartva),
      stackTrace frame-ek / breakpoint eventek / gotoTargets `py -> pine`,
      breakpointLocations szintetikus válasz a mapből (a mappelt Pine-sorok a
      breakpointolható sorok). Hiányzó/stale map (py_sha256 eltérés) ->
      figyelmeztetés + `.py`-szintű debug fallback.
- [x] Pine-statement stepping: step (next/stepIn/stepOut) után amíg a top frame
      ugyanarra a `.pine` sorra és frame-névre képződik le, a proxy elnyeli a
      stopot és own-seq újralép (cap: 50); breakpoint-stop azonnal felszínre
      kerül. Így egy lépés = egy Pine statement, több generált Python sor sosem
      látszik.
- [x] Fordítói átnevezések a Variables/Watch-ban — név-tábla NÉLKÜL: a pynecomp
      suffixek ABI-stabilak és determinisztikusak (`__global__` /
      `__<8hex>__` + ütközés-kerülő `_`-ok, `__ren__` / `__ren___`), így a
      Pine-név mintaillesztéssel visszanyerhető (`src/debug/demangle.ts`).
      TS: Variables/state-slot/objektum-mező nevek demangelve (listán belüli
      ütközésnél marad a mangled; `evaluateName` az igazi futásidejű név).
      Bridge: `watch`/`cond` alias-bind (a valódi név árnyékol) + series/
      persistent state Pine néven is. Fordító-oldali név-tábla későbbre, ha a
      minta-alapú visszafejtés valahol kevésnek bizonyul.
- [x] Bar-stepping a közös runner-bridge-en (F4 óta működik; `.pine` módban is
      változatlan — a rejtett bar-stop breakpoint `.py`-térben él, a klienst
      nem érinti).
- [x] EDH-ellenőrzés: `.pine` breakpoint + stepping + Variables/Watch +
      Next bar/Run to bar élőben, strict és normál fordítással is (v5-konverzió
      is). Strict a PyneIDE státuszsor-menüből kapcsolható
      (`pyneide.toggleStrictCompile`; a cache a strict flagre kulcsol, a
      következő Run/Debug újrafordít).

## F7 — Language serverek (L)

- [ ] Spike (1-2 nap): stub-trükk lefedettsége (`Series[T]` ~ `T`)
- [ ] Pine LS (pygls, pynecomp parser): diagnosztika, symbols, completion, hover
- [ ] Saját Pyright-példány + `.pyi` stubok + LSP-proxy diagnosztika-szűrés
- [ ] Pyne-checker (script-struktúra, Series-szabályok)
- [ ] Pine snippet-készlet

## F8 — Pyne Edge mód (M)

- [ ] `@pyne edge` felismerés + badge/színjelzés
- [ ] Edge-linter (importfehérlista + tiltott konstrukciók, verziózott szabálylista)

## F9 — Adat- és workspace-menedzsment UI (M)

- [ ] Tree view (scripts/data/output + metaadatok)
- [ ] Letöltés-varázsló, frissítés, truncate
- [ ] `.ohlcv` gyors-előnézet
- [ ] Input-UI (`input.*` form-alapú szerkesztés)

## F10 — Polírozás és publikálás (M)

- [ ] Walkthrough (környezet, API-kulcs, első futtatás)
- [ ] Hibariport + logcsatorna
- [ ] Marketplace + Open VSX publikálás (README, képek, demó GIF)
- [ ] Verziókezelési séma (pinnelt pynecore/pynecomp)

## F11 — Jövőbeli irányok (terven túl, nem ütemezett)

- [-] Marketplace-publikálás PyneSys oldalra, bot/live indítás, bar replay,
      TV-összehasonlító, PyneWeb szinergia — később döntendő
