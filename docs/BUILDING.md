# Building ClipPrep for macOS

ClipPrep is packaged with [electron-builder](https://www.electron.build/) into a standalone `ClipPrep.app`, distributed as a `.dmg` and a `.zip`. ffmpeg and ffprobe are bundled automatically. whisper.cpp can be bundled too, so the app works without Homebrew. Whisper models are not bundled; the app downloads them on first run.

## Prerequisites

- macOS with Xcode Command Line Tools (`xcode-select --install`)
- Node.js 20 or later
- CMake and Git, to build a bundleable `whisper-cli` (`brew install cmake`)
- Optional, for distribution: an Apple Developer ID certificate, for signing and notarization

## 1. Install dependencies

```bash
npm install
```

This also downloads the ffmpeg binary for the current machine's architecture (see [Intel builds](#intel-builds)).

## 2. Build a self-contained `whisper-cli` (recommended)

The app looks for `whisper-cli` in this order:

1. The path set in Settings
2. `ClipPrep.app/Contents/Resources/whisper/whisper-cli`
3. Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`)
4. `PATH`

Homebrew's `whisper-cli` links against Homebrew's own libraries, so it can't be copied into the app. To bundle one, build whisper.cpp statically:

```bash
git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_SDL2=OFF \
  -DWHISPER_BUILD_TESTS=OFF
cmake --build build -j --config Release --target whisper-cli
```

- `BUILD_SHARED_LIBS=OFF` produces a single binary that depends only on system frameworks.
- `GGML_NATIVE=OFF` stops the binary being tuned to the build machine's CPU (`-mcpu=native`), which could otherwise crash on older Macs.
- `GGML_METAL_EMBED_LIBRARY=ON` embeds the Metal shaders, so GPU acceleration works from inside the app bundle.

Check the result. `otool` should list only `/System/Library/…` and `/usr/lib/…` entries, and `--help` must list both `-dtw` and `-nfa`, which ClipPrep relies on:

```bash
otool -L build/bin/whisper-cli
./build/bin/whisper-cli --help | grep -E -- '-dtw|-nfa'
```

Copy it into the vendor folder for the target architecture. The folder is git-ignored and picked up by the build:

```bash
mkdir -p ../ClipPrep/vendor/whisper/arm64
cp build/bin/whisper-cli ../ClipPrep/vendor/whisper/arm64/
```

If this step is skipped, the build still succeeds; electron-builder logs `file source doesn't exist` for the whisper folder. The app then needs `brew install whisper-cpp` on each machine that runs it.

## 3. Build the app

For a quick local build, with no signing and no `.dmg`:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir
open dist/mac-arm64/ClipPrep.app
```

For a distributable `.dmg` and `.zip`:

```bash
npm run dist
```

Output goes to `dist/`.

### Signing and notarization

Unsigned builds run on the machine that built them. On other Macs, Gatekeeper blocks them until the user allows the app under **System Settings → Privacy & Security → Open Anyway**.

To sign and notarize, electron-builder needs a Developer ID Application certificate, from the login keychain or from `CSC_LINK` / `CSC_KEY_PASSWORD`, plus Apple notarization credentials in the environment:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
npm run dist
```

The bundled `whisper-cli`, `ffmpeg` and `ffprobe` are signed together with the app. Notarization fails if any binary inside the bundle is left unsigned, so add any extra executables under `Contents/Resources` rather than downloading them at runtime.

### App icon

Without an icon, the default Electron icon is used. Put a 1024×1024 `icon.icns` (or `icon.png`) in a `build/` folder at the project root, and electron-builder picks it up automatically.

## Intel builds

The steps above produce an Apple Silicon (`arm64`) build. For Intel Macs, build a separate `x64` app. A universal binary isn't practical, because `ffmpeg-static` installs a single-architecture binary.

```bash
# ffmpeg for x64
rm -rf node_modules/ffmpeg-static
npm_config_arch=x64 npm install ffmpeg-static

# whisper-cli for x64 (in the whisper.cpp checkout)
cmake -B build-x64 -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_SDL2=OFF -DWHISPER_BUILD_TESTS=OFF
cmake --build build-x64 -j --config Release --target whisper-cli
mkdir -p ../ClipPrep/vendor/whisper/x64 && cp build-x64/bin/whisper-cli ../ClipPrep/vendor/whisper/x64/

# package
npx electron-builder --mac --x64
```

Run `npm install` again afterwards to restore the arm64 ffmpeg for development. ffprobe needs no extra step, because `ffprobe-static` ships both architectures and the build keeps only the matching one.

The Intel build has not been tested on Intel hardware yet.

## What goes into the bundle

The `build` section of `package.json` controls packaging:

| Setting | Purpose |
|---|---|
| `files` | Only `src/` and `package.json` (plus production `node_modules`) are packaged. The ffprobe binaries for the other architecture are excluded. |
| `asarUnpack` | ffmpeg and ffprobe are unpacked from the asar archive so they can be executed. `src/core/media.js` rewrites `app.asar` → `app.asar.unpacked` in their paths. |
| `extraResources` | `vendor/whisper/<arch>/` is copied to `Contents/Resources/whisper/`. |

To check a build without launching the UI, run its modules with Electron in Node mode:

```bash
A=dist/mac-arm64/ClipPrep.app
ELECTRON_RUN_AS_NODE=1 "$A/Contents/MacOS/ClipPrep" -e "
  const R = '$PWD/$A/Contents/Resources';
  process.resourcesPath ??= R;
  console.log(require(R + '/app.asar/src/core/transcribe.js').findWhisper(''));
  require(R + '/app.asar/src/core/media.js').probe('/path/to/clip.mp4').then(console.log);"
```

This should print the bundled `whisper-cli` path and the probed clip info.
