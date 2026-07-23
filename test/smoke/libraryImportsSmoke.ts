import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  activeLibraryCall,
  discoverWorkspaceLibraries,
  isIncompletePineLibraryImport,
  libraryMemberFragment,
  libraryParameterName,
  librarySignatureParameters,
  parseLibraryDocumentation,
  parsePineLibraryExports,
  parsePyneLibraryExports,
  parseWorkspaceLibraryImport,
  pineImportFragment,
  pyneImportFragment,
  resolveWorkspaceLibraryFile,
  validateWorkspaceLibraryCall,
  workspaceLibraryCalls,
} from '../../src/workspace/libraryImports';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-library-imports-'));
try {
  const lib = path.join(workdir, 'scripts', 'lib', 'wallneradam', 'TestLib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'v1.pine'), '');
  fs.writeFileSync(path.join(lib, 'v1.py'), '');
  fs.writeFileSync(path.join(lib, 'v2.py'), '');
  fs.writeFileSync(path.join(lib, 'v2.py.map'), '');

  const libraries = discoverWorkspaceLibraries(workdir);
  assert(libraries.length === 2, `expected 2 versions, got ${libraries.length}`);
  assert(libraries[0].pineImport === 'wallneradam/TestLib/2', 'latest Pine path first');
  assert(libraries[0].pyneImport === 'lib.wallneradam.TestLib.v2', 'Pyne dotted path');
  assert(libraries[1].languages.join(',') === 'pine,pyne', 'paired sources are deduplicated');

  const pine = pineImportFragment('  import wallneradam/');
  assert(pine?.text === 'wallneradam/' && pine.start === 9, 'Pine fragment range');
  assert(pineImportFragment('import') === undefined, 'Pine completion starts after a space');
  assert(pyneImportFragment('import lib.wallneradam.')?.text === 'lib.wallneradam.', 'Pyne fragment');
  assert(pyneImportFragment('print(lib.') === undefined, 'non-import Python is ignored');
  const member = libraryMemberFragment('value = tl.my', 'pine');
  assert(
    member?.alias === 'tl' && member.text === 'my' && member.start === 11,
    'alias member fragment'
  );
  assert(libraryMemberFragment('value = tl.', 'pine')?.start === 11, 'empty alias member fragment');
  assert(libraryMemberFragment('// tl.', 'pine') === undefined, 'Pine comments are ignored');
  assert(libraryMemberFragment('value = "tl.', 'pine') === undefined, 'Pine strings are ignored');
  assert(libraryMemberFragment('# tl.', 'pyne') === undefined, 'Pyne comments are ignored');

  const pineImport = parseWorkspaceLibraryImport(
    'import wallneradam/TestLib/1 as tl',
    'pine'
  );
  assert(
    pineImport?.alias === 'tl' &&
      pineImport.pathStart === 7 &&
      pineImport.pathEnd === 28,
    'Pine definition import'
  );
  const pyneImport = parseWorkspaceLibraryImport(
    'import lib.wallneradam.TestLib.v1 as tl',
    'pyne'
  );
  assert(pyneImport?.alias === 'tl' && pyneImport.version === 1, 'Pyne definition import');
  assert(
    pineImport &&
      resolveWorkspaceLibraryFile(workdir, pineImport, 'pine') === path.join(lib, 'v1.pine'),
    'Pine definition prefers Pine source'
  );
  assert(
    pyneImport &&
      resolveWorkspaceLibraryFile(workdir, pyneImport, 'pyne') === path.join(lib, 'v1.py'),
    'Pyne definition prefers Pyne source'
  );

  const pineExports = parsePineLibraryExports(`//@version=6
library("TestLib")

// @function Smooth the source
// @param source Input series
// @returns Smoothed series
export smooth(
    series float source,
    simple int length = input.int(14, "Length")) =>
    ta.sma(source, length)

// @function Shift a value
export method shifted(float self, float amount) =>
    self + amount

helper(float source) => source
`);
  assert(
    pineExports.length === 2 &&
      pineExports[0].name === 'shifted' &&
      pineExports[0].kind === 'method' &&
      pineExports[1].signature ===
        'smooth(series float source, simple int length = input.int(14, "Length"))',
    `Pine callable exports: ${JSON.stringify(pineExports)}`
  );
  assert(
    pineExports[1].documentation?.includes('Smooth the source'),
    'Pine export documentation'
  );
  const documentation = parseLibraryDocumentation(pineExports[1].documentation);
  assert(
    documentation.summary === 'Smooth the source' &&
      documentation.parameters.source === 'Input series' &&
      documentation.returns === 'Smoothed series',
    `structured Pine documentation: ${JSON.stringify(documentation)}`
  );
  const signatureParameters = librarySignatureParameters(pineExports[1].signature);
  assert(
    signatureParameters.length === 2 &&
      libraryParameterName(signatureParameters[0], 'pine') === 'source' &&
      libraryParameterName(signatureParameters[1], 'pine') === 'length',
    `Pine signature parameters: ${JSON.stringify(signatureParameters)}`
  );
  assert(
    librarySignatureParameters(
      'lookup(map<string, array<float>> values, string key)'
    ).length === 2,
    'commas inside Pine generic types do not split parameters'
  );
  assert(
    activeLibraryCall(
      'value = tl.smooth(src, ta.sma(close, 2),\n    ',
      'pine'
    )?.activeParameter === 2,
    'nested arguments preserve the active signature parameter'
  );
  assert(
    activeLibraryCall('value = tl.smooth(src)', 'pine') === undefined,
    'a completed call does not keep signature help active'
  );

  const callSource = `
valid = tl.smooth(close)
missing = tl.smooth()
extra = tl.smooth(close, 14, 2)
unknown = tl.smooth(source=close, nope=1)
duplicate = tl.smooth(close, source=close)
nested = tl.smooth(ta.sma(close, 2), length=10)
ordered = tl.smooth(length=10, close)
text = "tl.smooth()"
// tl.smooth()
`;
  const calls = workspaceLibraryCalls(callSource, 'pine').filter(
    (call) => call.alias === 'tl'
  );
  assert(calls.length === 7, `expected 7 real library calls, got ${calls.length}`);
  const callIssues = calls.map((call) =>
    validateWorkspaceLibraryCall(call, pineExports[1], 'pine')
  );
  assert(callIssues[0].length === 0, 'required + defaulted arguments are valid');
  assert(
    callIssues[1].length === 1 &&
      callIssues[1][0].message.includes('source'),
    `missing required argument: ${JSON.stringify(callIssues[1])}`
  );
  assert(
    callIssues[2].length === 1 &&
      callIssues[2][0].code === 'pyne-lib-argument-count',
    `too many arguments: ${JSON.stringify(callIssues[2])}`
  );
  assert(
    callIssues[3].length === 1 &&
      callIssues[3][0].code === 'pyne-lib-argument-name',
    `unknown named argument: ${JSON.stringify(callIssues[3])}`
  );
  assert(
    callIssues[4].length === 1 &&
      callIssues[4][0].code === 'pyne-lib-argument-duplicate',
    `duplicate argument: ${JSON.stringify(callIssues[4])}`
  );
  assert(callIssues[5].length === 0, 'nested and named arguments bind correctly');
  assert(
    callIssues[6].length === 1 &&
      callIssues[6][0].code === 'pyne-lib-argument-order',
    `positional-after-named argument: ${JSON.stringify(callIssues[6])}`
  );

  const pyneExports = parsePyneLibraryExports(`"""
@pyne lib
"""
__all__ = [
    "smooth",
]

def smooth(
    source: float,
    length: int = 14,
) -> float:
    """Smooth the source."""
    return source

def helper() -> None:
    pass
`);
  assert(
    pyneExports.length === 1 &&
      pyneExports[0].name === 'smooth' &&
      pyneExports[0].signature === 'smooth(source: float, length: int = 14,) -> float',
    `Pyne callable exports: ${JSON.stringify(pyneExports)}`
  );
  assert(pyneExports[0].documentation === 'Smooth the source.', 'Pyne export documentation');
  const pyneCall = workspaceLibraryCalls(
    'value = tl.smooth(source=close)',
    'pyne'
  )[0];
  assert(
    validateWorkspaceLibraryCall(pyneCall, pyneExports[0], 'pyne').length === 0,
    'Pyne named + defaulted arguments are valid'
  );
  assert(
    validateWorkspaceLibraryCall(
      workspaceLibraryCalls('value = tl.smooth(close)', 'pine')[0],
      pyneExports[0],
      'pine'
    ).length === 0,
    'a Pine importer binds a .py-only library signature by its source syntax'
  );
  assert(
    workspaceLibraryCalls(
      '"""Docs mention tl.smooth() and "quotes"."""\nvalue = tl.smooth(close)',
      'pyne'
    ).length === 1,
    'Pyne calls inside triple-quoted strings are ignored'
  );

  const variadicExport = {
    name: 'flex',
    kind: 'function' as const,
    signature:
      'flex(a: int, /, b: int = 0, *args: float, c: int, **kwargs: object)',
  };
  const variadicCalls = workspaceLibraryCalls(
    [
      'ok = tl.flex(1, 2, 3, c=4, extra=5)',
      'posonly = tl.flex(a=1, c=2)',
      'missing = tl.flex(1)',
      'dynamic = tl.flex(*items)',
    ].join('\n'),
    'pyne'
  );
  assert(
    validateWorkspaceLibraryCall(variadicCalls[0], variadicExport, 'pyne').length === 0,
    'Pyne variadic and keyword-only arguments bind correctly'
  );
  assert(
    validateWorkspaceLibraryCall(variadicCalls[1], variadicExport, 'pyne')[0]?.code ===
      'pyne-lib-argument-name',
    'Pyne positional-only arguments reject names'
  );
  assert(
    validateWorkspaceLibraryCall(variadicCalls[2], variadicExport, 'pyne')[0]?.message.includes(
      'c'
    ),
    'Pyne keyword-only required arguments are checked'
  );
  assert(
    validateWorkspaceLibraryCall(variadicCalls[3], variadicExport, 'pyne').length === 0,
    'dynamic spreads are conservatively skipped'
  );

  const overloaded = {
    name: 'pick',
    kind: 'function' as const,
    signature: 'pick(float value)',
    overloads: ['pick(float value)', 'pick(float value, int offset)'],
  };
  const overloadCall = workspaceLibraryCalls('value = tl.pick(close, 1)', 'pine')[0];
  assert(
    validateWorkspaceLibraryCall(overloadCall, overloaded, 'pine').length === 0,
    'a call matching any overload is valid'
  );

  const compiledExports = parsePyneLibraryExports(`from typing import Protocol, Any
from pynecore.core.pine_export import Exported

__all__ = ['smooth']

class _ProtocolSmooth(Protocol):
    def __call__(self, source: float, length: int = 14) -> Any: ...

smooth: _ProtocolSmooth = Exported()
`);
  assert(
    compiledExports.length === 1 &&
      compiledExports[0].signature === 'smooth(source: float, length: int = 14) -> Any',
    `compiled Pyne callable export: ${JSON.stringify(compiledExports)}`
  );

  for (const line of [
    'import',
    'import ',
    'import wallneradam',
    'import wallneradam/',
    'import wallneradam/TestLib',
    'import wallneradam/TestLib/',
    'import wallneradam/TestLib/1 as',
  ]) {
    assert(isIncompletePineLibraryImport(line), `should be incomplete: ${JSON.stringify(line)}`);
  }
  for (const line of [
    'import wallneradam/TestLib/1',
    'import wallneradam/TestLib/1 as tl',
    'import wallneradam/TestLib/version',
    'import wallneradam/TestLib/0',
    'import /TestLib/1',
    'plot(close)',
  ]) {
    assert(!isIncompletePineLibraryImport(line), `should not be incomplete: ${JSON.stringify(line)}`);
  }

  console.log('library imports, member help, call diagnostics and definitions OK');
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
