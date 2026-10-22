import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location(
    'marketplace', Path(__file__).resolve().parents[1] / 'scripts' / 'marketplace.py')
marketplace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(marketplace)


class MarketplacePackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.assets = Path(temporary.name)
        self.manifest = {'publisher': 'pynesys', 'name': 'pyneide',
                         'version': '0.9.2', 'preview': True}
        self.release = {'tagName': 'v0.9.2', 'isDraft': False,
                        'isPrerelease': True, 'publishedAt': '2026-10-22T12:00:00Z'}
        self.write_json('package.json', self.manifest)
        self.write_json('release.json', self.release)
        self.write_package()

    def write_json(self, name, value):
        (self.assets / name).write_text(json.dumps(value))

    def write_package(self, manifest=None, identity_version='0.9.2', properties=''):
        package = self.assets / 'pyneide-0.9.2.vsix'
        with zipfile.ZipFile(package, 'w') as archive:
            archive.writestr('extension/package.json', json.dumps(
                self.manifest if manifest is None else manifest))
            archive.writestr('extension.vsixmanifest',
                '<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
                '<Metadata><Identity Publisher="pynesys" Id="pyneide" '
                f'Version="{identity_version}"/><Properties>{properties}</Properties>'
                '</Metadata></PackageManifest>')
        digest = hashlib.sha256(package.read_bytes()).hexdigest()
        (self.assets / 'SHA256SUMS').write_text(f'{digest}  {package.name}\n')

    def verify(self):
        return marketplace.verify_package('v0.9.2', self.assets)

    def test_valid_preview_and_stable(self):
        self.assertEqual(self.verify(), 'pyneide-0.9.2.vsix')
        self.manifest['preview'] = False
        self.release['isPrerelease'] = False
        self.write_json('package.json', self.manifest)
        self.write_json('release.json', self.release)
        self.write_package()
        self.verify()

    def test_invalid_release_and_tags(self):
        for tag in ('main', 'v0.9.2-beta.1', 'v00.9.2', 'v0.9.3'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                marketplace.verify_package(tag, self.assets)
        for change in ({'isDraft': True}, {'publishedAt': None}, {'tagName': 'v0.9.1'},
                       {'isPrerelease': False}):
            self.write_json('release.json', self.release | change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.verify()

    def test_changed_archive_is_rejected(self):
        with (self.assets / 'pyneide-0.9.2.vsix').open('ab') as package:
            package.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.verify()

    def test_checksum_cannot_select_another_file(self):
        for filename in ('other.vsix', '../pyneide-0.9.2.vsix', 'pyneide-0.9.1.vsix'):
            (self.assets / 'SHA256SUMS').write_text('0' * 64 + f'  {filename}\n')
            with self.subTest(filename=filename), self.assertRaisesRegex(ValueError, 'exactly'):
                self.verify()

    def test_extra_checksum_entries_are_rejected(self):
        checksum = self.assets / 'SHA256SUMS'
        checksum.write_text(checksum.read_text() * 2)
        with self.assertRaisesRegex(ValueError, 'exactly'):
            self.verify()

    def test_mismatched_vsix_metadata_is_rejected(self):
        for change in ({'publisher': 'other'}, {'name': 'other'}, {'version': '0.9.1'},
                       {'preview': False}, {'preview': 'true'}):
            self.write_package(self.manifest | change)
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'VSIX'):
                self.verify()

    def test_mismatched_xml_identity_is_rejected(self):
        self.write_package(identity_version='0.9.1')
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.verify()

    def test_preview_does_not_select_the_pre_release_channel(self):
        self.write_package(properties='<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/>')
        with self.assertRaisesRegex(ValueError, 'pre-release channel'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
