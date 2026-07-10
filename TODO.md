# PyneIDE — TODO

Állapotkövetés a `PLAN.md` fázisaihoz. Jelölés: `[ ]` nyitott, `[x]` kész,
`[-]` kihagyva/elhalasztva. Az aktuális fázis részletes; a későbbiek csak
mérföldkő-szinten vannak felbontva, a fázis megkezdésekor bontjuk ki őket.

**Aktuális fázis: F0**

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
- [ ] Licenc-döntés (addig: `--skip-license` a csomagolásnál, README "TBD")
- [ ] `repository.url` a package.json-ban placeholder (github.com/pynesys/pyneide)
- [ ] Vizuális smoke-teszt VSCode-ban (Pine highlight, Pyne badge)

## F1 — Python környezet bootstrap (M)

- [ ] `uv` letöltés/bundle + dedikált venv a `globalStorage`-ban
- [ ] Pinnelt `pynecore[all]` + `debugpy` telepítés (Python 3.14)
- [ ] Környezet-ellenőrző status bar + "Setup Environment" parancs
- [ ] Override-ok: `pyneide.pythonPath`, `pyneide.venvPath`, `pyneide.useOwnPynecore`
- [ ] Workdir-kezelés + "Create Pyne workspace" parancs
- [ ] CI smoke-teszt mindhárom OS-en

## F2 — PyneSys fiók és Pine fordítás (M)

- [ ] API-kulcs kezelés (SecretStorage, "Sign in" parancs, validálás)
- [ ] Migrációs mód / Pine-first mód (explicit módválasztás)
- [ ] `Pine: Compile` parancs + compile-on-save (debounce, 429-sorbaállítás)
- [ ] Hibaválasz -> VSCode diagnostics (sor-szintű)
- [ ] Kvóta-visszajelzés (429/413/402 emberi nyelven)
- [ ] Lokális fordítási cache (tartalomhash)

## F3 — Futtatás és chart (L) — első "wow" mérföldkő

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
