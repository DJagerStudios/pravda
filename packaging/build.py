#!/usr/bin/env python3
"""Builds Pravda's downloads: the desktop app for Linux, Windows and macOS on
x86 and ARM, the standalone server for each, checksums and the signed update
manifest that the desktop app's updater reads.

    python3 -I packaging/build.py                       # every target
    python3 -I packaging/build.py --targets linux-x86_64 --no-appimage
    python3 -I packaging/build.py --version 0.3.1-beta.1 --out /tmp/dist

Everything downloaded (Electron, appimagetool and its runtimes) is checked
against the SHA-256 sums pinned below before it is used.

The update manifest is signed with the release key: PRAVDA_SIGNING_KEY holds
the PEM text (as in CI), or ~/.config/pravda/release-signing-key.pem is used.
Without a key the manifest is left unsigned, and installed copies will not
update to that build.

macOS builds are not signed or notarised, and Windows builds keep Electron's
icon on the .exe itself; docs/DESKTOP.md explains both.
"""

import argparse
import base64
import datetime
import hashlib
import io
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'dist' / 'cache'

ELECTRON = '44.10.1'
ELECTRON_SHA256 = {
    'linux-x64': '2be868b71b0aa71f30e6b5567a106a35a049385e963183c074aad1975ead5167',
    'linux-arm64': '0e16c008d628a9c8758ee75b6e2faf2f2ee5365e7e522f0884c8e52d0d551d2c',
    'win32-x64': '5099bdc11c6a78edff35851491c1f8228a1c2e844e1b376eee219402c42c6011',
    'win32-arm64': '220b9496d7128880f85bba62dde7a4120c54b2b3f8c3e3851fb6f1f762db2940',
    'darwin-arm64': '687f922034f1e991ab34ed7f47c4cb4e5c5e85e974b0ce155c22ce6d6f699aa3',
    'darwin-x64': 'd1c49452bd009411705d0d2ba140e126b6fdd2f69db837437327aab0b2476c2c',
}
APPIMAGETOOL = ('1.9.1', 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0')
APPIMAGE_RUNTIME = ('20251108', {
    'x86_64': '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
    'aarch64': '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444',
})

# target: (Electron platform, GOOS, GOARCH, Linux arch, Debian arch)
TARGETS = {
    'linux-x86_64': ('linux-x64', 'linux', 'amd64', 'x86_64', 'amd64'),
    'linux-aarch64': ('linux-arm64', 'linux', 'arm64', 'aarch64', 'arm64'),
    'windows-x64': ('win32-x64', 'windows', 'amd64', None, None),
    'windows-arm64': ('win32-arm64', 'windows', 'arm64', None, None),
    'macos-arm64': ('darwin-arm64', 'darwin', 'arm64', None, None),
    'macos-x64': ('darwin-x64', 'darwin', 'amd64', None, None),
}

# The desktop shell's own files, copied into resources/app.
DESKTOP_FILES = ['main.js', 'preload.js', 'picker-preload.js', 'update.js', 'package.json', 'release-key.pem', 'ui', 'icons']

DEB_DEPENDS = ', '.join([
    'libgtk-3-0 | libgtk-3-0t64', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils',
    'libatspi2.0-0 | libatspi2.0-0t64', 'libuuid1', 'libsecret-1-0', 'libasound2 | libasound2t64', 'libgbm1', 'libdrm2',
])


def log(msg):
    print(f'==> {msg}', flush=True)


def run(cmd, **kw):
    subprocess.run(cmd, check=True, **kw)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def fetch(url, dest, expected):
    """Downloads url to dest unless a verified copy is already there."""
    if dest.exists() and sha256(dest) == expected:
        return dest
    log(f'downloading {url}')
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.part')
    with urllib.request.urlopen(url, timeout=120) as res, open(tmp, 'wb') as out:
        shutil.copyfileobj(res, out)
    actual = sha256(tmp)
    if actual != expected:
        tmp.unlink()
        sys.exit(f'checksum mismatch for {url}\n  expected {expected}\n  got      {actual}')
    tmp.rename(dest)
    return dest


def code_version():
    src = (ROOT / 'internal/server/server.go').read_text()
    v = re.search(r'var Version = "([^"]+)"', src).group(1)
    pkg = json.loads((ROOT / 'desktop/package.json').read_text())['version']
    if pkg != v:
        sys.exit(f'version mismatch: server {v}, desktop/package.json {pkg}')
    return v


def go_binary():
    found = shutil.which('go')
    if found:
        return found
    fallback = Path.home() / '.local/share/toolchains/go/bin/go'
    if fallback.exists():
        return str(fallback)
    sys.exit('Go is needed to build the server.')


def build_server(goos, goarch, out, ver):
    log(f'building the server for {goos}/{goarch}')
    out.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, CGO_ENABLED='0', GOOS=goos, GOARCH=goarch)
    flags = f'-s -w -X pravda/internal/server.Version={ver}'
    run([go_binary(), 'build', '-trimpath', '-ldflags', flags, '-o', str(out), './cmd/pravda'], cwd=ROOT, env=env)
    return out


# ---- icons ------------------------------------------------------------------

def icon_png(size):
    from PIL import Image  # only needed for packaging
    src = Image.open(ROOT / 'packaging/icons/icon-1024.png').convert('RGBA')
    buf = io.BytesIO()
    src.resize((size, size), Image.LANCZOS).save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def write_icns(path):
    """An .icns of PNG entries, which macOS has accepted since 10.7."""
    kinds = [('ic11', 32), ('ic12', 64), ('ic07', 128), ('ic13', 256), ('ic08', 256), ('ic14', 512), ('ic09', 512), ('ic10', 1024)]
    pngs = {size: icon_png(size) for _, size in kinds}
    body = b''.join(kind.encode() + (8 + len(pngs[size])).to_bytes(4, 'big') + pngs[size] for kind, size in kinds)
    path.write_bytes(b'icns' + (8 + len(body)).to_bytes(4, 'big') + body)


def write_ico(path):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    pngs = {size: icon_png(size) for size in sizes}
    header = (0).to_bytes(2, 'little') + (1).to_bytes(2, 'little') + len(sizes).to_bytes(2, 'little')
    offset = 6 + 16 * len(sizes)
    entries, data = b'', b''
    for size in sizes:
        png = pngs[size]
        dim = 0 if size == 256 else size
        entries += bytes([dim, dim, 0, 0]) + (1).to_bytes(2, 'little') + (32).to_bytes(2, 'little')
        entries += len(png).to_bytes(4, 'little') + offset.to_bytes(4, 'little')
        offset += len(png)
        data += png
    path.write_bytes(header + entries + data)


# ---- assembling ---------------------------------------------------------------

class Build:
    def __init__(self, ver, out, appimage, deb):
        self.ver = ver
        self.out = out
        self.stage = out / 'stage'
        self.appimage = appimage
        self.deb = deb
        self.outputs = []  # artifacts, in order
        self.updates = {}  # manifest key -> artifact path

    def name(self, target, suffix=''):
        return f'Pravda-{self.ver}-{target}{suffix}'

    def app_payload(self, dest):
        """resources/app: the desktop shell, the web client and the icon."""
        dest.mkdir(parents=True, exist_ok=True)
        for name in DESKTOP_FILES:
            src = ROOT / 'desktop' / name
            if src.is_dir():
                shutil.copytree(src, dest / name)
            else:
                shutil.copy2(src, dest / name)
        pkg = json.loads((dest / 'package.json').read_text())
        pkg['version'] = self.ver
        (dest / 'package.json').write_text(json.dumps(pkg, indent=2) + '\n')
        shutil.copytree(ROOT / 'web/public', dest / 'web')
        shutil.copy2(ROOT / 'packaging/icons/icon-512.png', dest / 'icon.png')

    @staticmethod
    def legal(dest):
        shutil.copy2(ROOT / 'LICENSE', dest / 'LICENSE')
        shutil.copytree(ROOT / 'LICENSES', dest / 'LICENSES', dirs_exist_ok=True)

    @staticmethod
    def unzip(archive, dest):
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        run(['unzip', '-q', str(archive), '-d', str(dest)])  # unzip keeps macOS symlinks
        # Electron's zips carry world-writable modes; nothing we ship may be.
        for path in [dest, *dest.rglob('*')]:
            if path.is_symlink():
                continue
            mode = path.stat().st_mode
            path.chmod(0o755 if path.is_dir() or mode & 0o111 else 0o644)

    @staticmethod
    def zip_dir(folder, archive, *names):
        archive.unlink(missing_ok=True)
        run(['zip', '-qry', '-X', str(archive), *names], cwd=folder)  # -y stores symlinks as links

    def tar_dir(self, folder_name, archive):
        archive.unlink(missing_ok=True)
        run(['tar', '-C', str(self.stage), '--owner=0', '--group=0', '-czf', str(archive), folder_name])

    def add(self, path, update_key=None):
        self.outputs.append(path)
        if update_key:
            self.updates[update_key] = path
        return path

    # -- Linux --

    def linux(self, target, electron_zip, server):
        _, _, _, arch, deb_arch = TARGETS[target]
        name = self.name(target)
        folder = self.stage / name
        self.unzip(electron_zip, folder)
        (folder / 'electron').rename(folder / 'pravda')
        (folder / 'resources/default_app.asar').unlink(missing_ok=True)
        self.app_payload(folder / 'resources/app')
        (folder / 'resources/server').mkdir()
        shutil.copy2(server, folder / 'resources/server/pravda')
        shutil.copy2(ROOT / 'packaging/icons/icon-512.png', folder / 'pravda.png')
        (folder / 'pravda.desktop').write_text(desktop_entry('pravda %U'))
        (folder / 'install.sh').write_text(LINUX_INSTALL)
        (folder / 'install.sh').chmod(0o755)
        self.legal(folder)
        log(f'packing {name}.tar.gz')
        self.tar_dir(name, self.out / f'{name}.tar.gz')
        self.add(self.out / f'{name}.tar.gz', f'linux-{arch}-tar')
        if self.appimage:
            self.add(self.build_appimage(folder, target, arch), f'linux-{arch}-appimage')
        if self.deb:
            self.add(self.build_deb(folder, target, deb_arch), f'linux-{arch}-deb')

    def build_appimage(self, folder, target, arch):
        tool = fetch(f'https://github.com/AppImage/appimagetool/releases/download/{APPIMAGETOOL[0]}/appimagetool-x86_64.AppImage',
                     CACHE / f'appimagetool-{APPIMAGETOOL[0]}-x86_64.AppImage', APPIMAGETOOL[1])
        runtime = fetch(f'https://github.com/AppImage/type2-runtime/releases/download/{APPIMAGE_RUNTIME[0]}/runtime-{arch}',
                        CACHE / f'runtime-{APPIMAGE_RUNTIME[0]}-{arch}', APPIMAGE_RUNTIME[1][arch])
        tool.chmod(0o755)
        appdir = self.stage / f'Pravda-{arch}.AppDir'
        if appdir.exists():
            shutil.rmtree(appdir)
        shutil.copytree(folder, appdir, symlinks=True)
        (appdir / 'install.sh').unlink()
        (appdir / 'AppRun').write_text(APPRUN)
        (appdir / 'AppRun').chmod(0o755)
        (appdir / 'pravda.desktop').write_text(desktop_entry('pravda %U'))
        (appdir / '.DirIcon').symlink_to('pravda.png')
        out = self.out / self.name(target, '.AppImage')
        out.unlink(missing_ok=True)
        log(f'packing {out.name}')
        env = dict(os.environ, ARCH=arch, APPIMAGE_EXTRACT_AND_RUN='1')
        run([str(tool), '--no-appstream', '--runtime-file', str(runtime), str(appdir), str(out)], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return out

    def build_deb(self, folder, target, deb_arch):
        """A .deb that installs into /opt/Pravda, written without dpkg-deb."""
        out = self.out / f'Pravda-{self.ver}-linux-{deb_arch}.deb'
        log(f'packing {out.name}')
        root = self.stage / f'deb-{deb_arch}'
        if root.exists():
            shutil.rmtree(root)
        opt = root / 'opt/Pravda'
        shutil.copytree(folder, opt, symlinks=True)
        for extra in ('install.sh', 'pravda.desktop'):
            (opt / extra).unlink()
        apps = root / 'usr/share/applications'
        apps.mkdir(parents=True)
        (apps / 'pravda.desktop').write_text(desktop_entry('/opt/Pravda/pravda %U'))
        for size in (128, 256, 512):
            icons = root / f'usr/share/icons/hicolor/{size}x{size}/apps'
            icons.mkdir(parents=True)
            (icons / 'pravda.png').write_bytes(icon_png(size))

        files = sorted(p for p in root.rglob('*') if p.is_file() or p.is_symlink())
        size_kb = sum(p.lstat().st_size for p in files) // 1024 + 1
        md5sums = ''.join(f'{hashlib.md5(p.read_bytes()).hexdigest()}  {p.relative_to(root)}\n' for p in files if p.is_file() and not p.is_symlink())
        deb_version = self.ver.replace('-', '~')  # 0.3.0~beta.1 sorts before 0.3.0
        control = '\n'.join([
            'Package: pravda',
            f'Version: {deb_version}',
            'Section: net',
            'Priority: optional',
            f'Architecture: {deb_arch}',
            'Maintainer: DJagerStudios <194205770+DJagerStudios@users.noreply.github.com>',
            f'Installed-Size: {size_kb}',
            f'Depends: {DEB_DEPENDS}',
            'Homepage: https://github.com/DJagerStudios/pravda',
            'Description: End-to-end encrypted chat, voice and video',
            ' Pravda is a self-hosted place for communities to talk: servers with text',
            ' and voice channels, direct messages, calls, video, screen sharing and',
            ' watching videos together, all end-to-end encrypted.',
            '',
        ])
        postinst = '#!/bin/sh\nset -e\nif command -v update-desktop-database >/dev/null; then update-desktop-database -q || true; fi\n'

        def tar_bytes(add):
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode='w:gz', format=tarfile.GNU_FORMAT) as tar:
                add(tar)
            return buf.getvalue()

        def owned_by_root(info):
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            if not info.issym():
                info.mode = 0o755 if info.isdir() or info.mode & 0o111 else 0o644
            if info.name.endswith('opt/Pravda/chrome-sandbox'):
                info.mode = 0o4755  # Chromium's sandbox helper must be setuid root
            return info

        def add_control(tar):
            for fname, text, mode in (('control', control, 0o644), ('md5sums', md5sums, 0o644), ('postinst', postinst, 0o755)):
                data = text.encode()
                info = tarfile.TarInfo(f'./{fname}')
                info.size, info.mode = len(data), mode
                tar.addfile(owned_by_root(info), io.BytesIO(data))

        def add_data(tar):
            for top in sorted(root.iterdir()):
                tar.add(top, arcname=f'./{top.name}', filter=owned_by_root)

        members = [('debian-binary', b'2.0\n'), ('control.tar.gz', tar_bytes(add_control)), ('data.tar.gz', tar_bytes(add_data))]
        with open(out, 'wb') as f:
            f.write(b'!<arch>\n')
            for name, data in members:
                header = f'{name:<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode()
                f.write(header + data + (b'\n' if len(data) % 2 else b''))
        return out

    # -- Windows --

    def windows(self, target, electron_zip, server):
        arch = target.split('-')[1]
        name = self.name(target)
        folder = self.stage / name
        self.unzip(electron_zip, folder)
        (folder / 'electron.exe').rename(folder / 'Pravda.exe')
        (folder / 'resources/default_app.asar').unlink(missing_ok=True)
        self.app_payload(folder / 'resources/app')
        (folder / 'resources/server').mkdir()
        shutil.copy2(server, folder / 'resources/server/pravda.exe')
        write_ico(folder / 'pravda.ico')
        self.legal(folder)
        out = self.out / f'{name}.zip'
        log(f'packing {out.name}')
        self.zip_dir(self.stage, out, name)
        self.add(out, f'windows-{arch}-zip')

    # -- macOS --

    def mac(self, target, electron_zip, server):
        arch = target.split('-')[1]
        name = self.name(target)
        folder = self.stage / name
        self.unzip(electron_zip, folder)
        bundle = folder / 'Pravda.app'
        (folder / 'Electron.app').rename(bundle)
        resources = bundle / 'Contents/Resources'
        (resources / 'default_app.asar').unlink(missing_ok=True)
        self.app_payload(resources / 'app')
        (resources / 'server').mkdir()
        shutil.copy2(server, resources / 'server/pravda')
        write_icns(resources / 'electron.icns')
        info_path = bundle / 'Contents/Info.plist'
        with open(info_path, 'rb') as f:
            info = plistlib.load(f)
        info.update({
            'CFBundleName': 'Pravda',
            'CFBundleDisplayName': 'Pravda',
            'CFBundleIdentifier': 'org.pravda.desktop',
            'CFBundleShortVersionString': self.ver,
            'CFBundleVersion': self.ver,
            'LSApplicationCategoryType': 'public.app-category.social-networking',
            'NSMicrophoneUsageDescription': 'Pravda uses the microphone for voice calls.',
            'NSCameraUsageDescription': 'Pravda uses the camera for video calls.',
            'NSHumanReadableCopyright': 'Pravda contributors. AGPL-3.0-or-later.',
        })
        with open(info_path, 'wb') as f:
            plistlib.dump(info, f)
        self.legal(folder)
        out = self.out / f'{name}.zip'
        log(f'packing {out.name}')
        self.zip_dir(folder, out, *sorted(p.name for p in folder.iterdir()))
        self.add(out, f'macos-{arch}-zip')

    # -- the server on its own --

    def server_archive(self, target, server):
        goos = TARGETS[target][1]
        name = f'Pravda-server-{self.ver}-{target}'
        folder = self.stage / name
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)
        shutil.copy2(server, folder / server.name)
        shutil.copy2(ROOT / 'README.md', folder / 'README.md')
        shutil.copy2(ROOT / 'docs/HOSTING.md', folder / 'HOSTING.md')
        self.legal(folder)
        if goos == 'windows':
            out = self.out / f'{name}.zip'
            self.zip_dir(self.stage, out, name)
        else:
            out = self.out / f'{name}.tar.gz'
            self.tar_dir(name, out)
        self.add(out)

    # -- the update manifest and checksums --

    def manifest(self, prerelease):
        files = {key: {'name': p.name, 'size': p.stat().st_size, 'sha256': sha256(p)} for key, p in sorted(self.updates.items())}
        data = json.dumps({
            'version': self.ver,
            'prerelease': prerelease,
            'released': datetime.date.today().isoformat(),
            'files': files,
        }, indent=2, sort_keys=True).encode() + b'\n'
        path = self.out / f'Pravda-{self.ver}-update.json'
        path.write_bytes(data)
        self.add(path)
        signature = sign(path)
        if signature:
            self.add(signature)
        else:
            log('WARNING: no signing key; installed copies will not update to this build')

    def checksums(self):
        path = self.out / f'Pravda-{self.ver}-SHA256SUMS'
        path.write_text(''.join(f'{sha256(p)}  {p.name}\n' for p in self.outputs))
        self.outputs.append(path)


def sign(manifest):
    """Signs the manifest with the release key, and checks the signature
    against the public key the app carries."""
    key_text = os.environ.get('PRAVDA_SIGNING_KEY')
    key_file = Path.home() / '.config/pravda/release-signing-key.pem'
    if not key_text and not key_file.exists():
        return None
    with tempfile.TemporaryDirectory() as tmp:
        key = Path(tmp) / 'key.pem'
        if key_text:
            key.write_text(key_text if key_text.endswith('\n') else key_text + '\n')
            key.chmod(0o600)
        else:
            key = key_file
        raw = Path(tmp) / 'sig.bin'
        run(['openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin', '-in', str(manifest), '-out', str(raw)])
        check = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(ROOT / 'desktop/release-key.pem'),
                                '-rawin', '-in', str(manifest), '-sigfile', str(raw)], capture_output=True)
        if check.returncode != 0:
            sys.exit('the signing key does not match desktop/release-key.pem; refusing to publish')
        out = manifest.with_name(manifest.name + '.sig')
        out.write_text(base64.b64encode(raw.read_bytes()).decode() + '\n')
        return out


def desktop_entry(exec_line):
    return '\n'.join([
        '[Desktop Entry]',
        'Type=Application',
        'Name=Pravda',
        'GenericName=Encrypted chat',
        'Comment=End-to-end encrypted chat, voice and video',
        f'Exec={exec_line}',
        'Icon=pravda',
        'Terminal=false',
        'Categories=Network;Chat;InstantMessaging;',
        'Keywords=chat;voice;video;encrypted;messaging;',
        'StartupWMClass=pravda',
        '',
    ])


LINUX_INSTALL = r'''#!/bin/sh
# Adds Pravda to your application menu, running it from this folder.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
mkdir -p "$apps" "$icons"
cp "$here/pravda.png" "$icons/pravda.png"
sed "s#^Exec=.*#Exec=\"$here/pravda\" %U#" "$here/pravda.desktop" > "$apps/pravda.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
echo "Pravda is in your application menu."
'''

APPRUN = '''#!/bin/sh
here="$(dirname "$(readlink -f "$0")")"
exec "$here/pravda" "$@"
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--targets', default='all', help=f'comma-separated: {", ".join(TARGETS)}, or "all" (the default)')
    parser.add_argument('--version', help='build as this version (release builds pass the tag; it must match the code unless --force-version)')
    parser.add_argument('--force-version', action='store_true', help='allow --version to differ from the code (for update tests)')
    parser.add_argument('--out', default=str(ROOT / 'dist'), help='output folder (default: dist)')
    parser.add_argument('--no-appimage', action='store_true', help='skip the Linux AppImages')
    parser.add_argument('--no-deb', action='store_true', help='skip the Debian packages')
    parser.add_argument('--server-only', action='store_true', help='build only the standalone server archives')
    args = parser.parse_args()
    targets = list(TARGETS) if args.targets == 'all' else [t.strip() for t in args.targets.split(',') if t.strip()]
    unknown = [t for t in targets if t not in TARGETS]
    if unknown:
        sys.exit(f'unknown target(s): {", ".join(unknown)}')

    ver = code_version()
    if args.version and args.version.lstrip('v') != ver:
        if not args.force_version:
            sys.exit(f'--version {args.version} does not match the code ({ver}); bump the version or pass --force-version')
        ver = args.version.lstrip('v')
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    build = Build(ver, out, appimage=not args.no_appimage, deb=not args.no_deb)
    build.stage.mkdir(parents=True, exist_ok=True)
    for target in targets:
        eplat, goos, goarch, _, _ = TARGETS[target]
        server = build_server(goos, goarch, build.stage / 'server' / target / ('pravda.exe' if goos == 'windows' else 'pravda'), ver)
        build.server_archive(target, server)
        if args.server_only:
            continue
        zip_name = f'electron-v{ELECTRON}-{eplat}.zip'
        electron_zip = fetch(f'https://github.com/electron/electron/releases/download/v{ELECTRON}/{zip_name}',
                             CACHE / zip_name, ELECTRON_SHA256[eplat])
        if goos == 'linux':
            build.linux(target, electron_zip, server)
        elif goos == 'windows':
            build.windows(target, electron_zip, server)
        else:
            build.mac(target, electron_zip, server)
    if not args.server_only:
        build.manifest(prerelease='-' in ver)
    build.checksums()
    log('done:')
    for path in build.outputs:
        print(f'    {path.relative_to(out.parent) if out.parent in path.parents else path}  ({path.stat().st_size / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
