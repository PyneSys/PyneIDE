import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  discoverWorkspaceLibraries,
  isIncompletePineLibraryImport,
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

  console.log('library import completion, definition and transient-diagnostic rules OK');
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
