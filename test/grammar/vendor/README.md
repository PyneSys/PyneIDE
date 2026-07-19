# Vendored grammars (test-only)

`MagicPython.tmLanguage.json` — the Python TextMate grammar VS Code ships,
from [MagicPython](https://github.com/MagicStack/MagicPython) (MIT).

It is vendored here so `npm run test:grammar:pyne` can exercise our
`pyne.injection` grammar against the real host grammar on CI, where no
VS Code installation exists. Not shipped in the VSIX (`test/**` is in
`.vscodeignore`).

Refresh with:

    cp "<vscode>/Contents/Resources/app/extensions/python/syntaxes/MagicPython.tmLanguage.json" test/grammar/vendor/
