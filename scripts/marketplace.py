"""Validate a GitHub release's existing VSIX before Marketplace publication."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile


def verify_package(tag: str, assets: Path) -> str:
    if not re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag):
        raise ValueError('Release tag must be v<major.minor.patch>')
    version = tag[1:]
    filename = f'pyneide-{version}.vsix'
    release = json.loads((assets / 'release.json').read_text())
    if (release.get('tagName') != tag or release.get('isDraft') is not False
            or not release.get('publishedAt')):
        raise ValueError('Only the matching published GitHub release can be uploaded')
    manifest = json.loads((assets / 'package.json').read_text())
    if (manifest.get('publisher'), manifest.get('name'), manifest.get('version')) != (
            'pynesys', 'pyneide', version):
        raise ValueError('Release tag must identify the pynesys.pyneide package version')
    preview = manifest.get('preview', False)
    if not isinstance(preview, bool) or release.get('isPrerelease') is not preview:
        raise ValueError('GitHub release and package Preview metadata must match')
    checksum = (assets / 'SHA256SUMS').read_text().strip()
    match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *]' + re.escape(filename), checksum)
    if not match:
        raise ValueError('SHA256SUMS must contain exactly the versioned release VSIX')
    package = assets / filename
    if hashlib.sha256(package.read_bytes()).hexdigest() != match[1].lower():
        raise ValueError('Release VSIX checksum does not match SHA256SUMS')
    with zipfile.ZipFile(package) as archive:
        bad_file = archive.testzip()
        if bad_file:
            raise ValueError(f'Corrupt file in VSIX: {bad_file}')
        packaged = json.loads(archive.read('extension/package.json'))
        for key in ('publisher', 'name', 'version'):
            if packaged.get(key) != manifest.get(key):
                raise ValueError(f'VSIX {key} does not match the release tag manifest')
        if packaged.get('preview', False) is not preview:
            raise ValueError('VSIX Preview metadata does not match the release tag manifest')
        vsix = ET.fromstring(archive.read('extension.vsixmanifest'))
    ns = {'v': 'http://schemas.microsoft.com/developer/vsx-schema/2011'}
    identity = vsix.find('v:Metadata/v:Identity', ns)
    if identity is None or (
            identity.get('Publisher'), identity.get('Id'), identity.get('Version')) != (
            'pynesys', 'pyneide', version):
        raise ValueError('VSIX identity does not match pynesys.pyneide and the release version')
    for prop in vsix.findall('v:Metadata/v:Properties/v:Property', ns):
        if (prop.get('Id') == 'Microsoft.VisualStudio.Code.PreRelease'
                and prop.get('Value', '').lower() == 'true'):
            raise ValueError('The Marketplace pre-release channel is separate from Preview labeling')
    return filename


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--assets', required=True, type=Path)
    args = parser.parse_args()
    try:
        filename = verify_package(args.tag, args.assets)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        parser.exit(1, f'{error}\n')
    print(f'Verified {filename}: checksum, package identity, version and Preview metadata')
