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
      documentation.returns === undefined,
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

  console.log('library import/member completion, definition and transient-diagnostic rules OK');
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
