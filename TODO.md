# PyneIDE — TODO

Állapotkövetés a `PLAN.md` fázisaihoz. Jelölés: `[ ]` nyitott, `[x]` kész,
`[-]` kihagyva/elhalasztva. Az aktuális fázis részletes; a későbbiek csak
mérföldkő-szinten vannak felbontva, a fázis megkezdésekor bontjuk ki őket.

**Aktuális fázis: F2 kész (élő teszt vár) -> F3 következik**

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
- [x] Workdir-kezelés
  - [x] `findWorkdir()` a pynecore `AppState._find_workdir` tükrözése
        (felfelé keresés max 10 szint, `workdir` nevű mappa)
  - [x] `PyneIDE: Create Pyne Workspace` parancs: workdir/ + scripts/, data/,
        config/, output/ + demó script (`@pyne`, SMA/EMA indikátor) + README
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
- [x] Módválasztás (explicit, workspace-szinten): migrációs mód (egyszeri
      fordítás, felülírás-védelem hash-alapon) / Pine-first mód (a `.py`
      derivált, generált-fájl figyelmeztetés szerkesztéskor)
- [x] `Pine: Compile` parancs + compile-on-save Pine-first módban (debounce,
      soros fordítási sor, compile-lock 429 újrapróbálás)
- [x] Hibaválasz -> VSCode diagnostics (sor-szintű, teljes sor jelölve)
- [x] Kvóta-visszajelzés: 429/413/402/401 emberi nyelven + `Show API Usage`
      parancs (napi/órás limit, reset-idő)
- [x] Lokális fordítási cache (tartalomhash + strict flag; kíméli a kvótát)
- [x] Gitignore-ajánlás a generált `.py`-ra Pine-first módban (egyszeri)

F2 nyitott: élő végpont-teszt valódi API-kulccsal (Sign In -> Compile ->
diagnostics) a felhasználóra vár; a kliens-szerződés curl-lel ellenőrizve.

## F3 — Futtatás és chart (L) — első "wow" mérföldkő

- [ ] Workdir-feloldási lánc (elfogadva 2026-07-10): `pyneide.workdir`
      resource-szkópú beállítás > felfelé keresés a script mappájától >
      felfelé keresés a workspace foldertől > létrehozás felajánlása;
      spawn-oknál mindig explicit `--workdir` / `PYNE_WORK_DIR` átadás,
      a feloldott workdir látszik a UI-ban (tooltip)
- [ ] Runner-bridge Python-csomag (`run_iter()` + NDJSON stream + stdin vezérlés)
- [ ] Chart webview KLineCharttal (gyertyák, plotok, trade-markerek, equity)
- [ ] Adatválasztó UI + `pyne data download` integráció
- [ ] Run CodeLens / editor-title gomb (Pine: fordítás + futtatás)
- [ ] Trade lista / statisztika táblázat-nézet
- [ ] Teljesítmény-teszt: 100k+ bar a webview-ban

## F4 — Pyne debugger (M)

- [ ] debugpy launch-konfiguráció (venv, workdir, adatforrás)
- [ ] Import-hook sorszám-megőrzés smoke-teszt
- [ ] Bar-szintű vezérlés v1 ("Run to next bar" / "Run to bar N")
- [ ] Series/Persistent változó-megjelenítés a Variables panelben

## F5 — Sourcemap a PyneComp-ban + API-kiterjesztés (M, külső repo)

- [ ] Emitter instrumentálás: `(kimeneti_sor, stmt.lineno)` rögzítés
- [ ] Blank-line collapse mapping-korrekció
- [ ] `pynecomp compile --sourcemap` -> `<stem>.py.map`
- [ ] API: `sourcemap=true` param, `{code, sourcemap}` JSON válasz
- [ ] Runtime traceback -> Pine sor visszafordítás

## F6 — Pine debugger (M-L)

- [ ] DAP-proxy (`pine` debug type, sourcemap-fordítás oda-vissza)
- [ ] Név-tábla a fordítói átnevezésekhez (Variables panel)
- [ ] Bar-stepping a közös runner-bridge-en

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
