#!/usr/bin/env bash

set -euo pipefail

: "${TOOL_TARGET:?TOOL_TARGET must be set}"

case "$TOOL_TARGET" in
    darwin-x64|mac-x64)
        target_arch=x86_64
        ffmpeg_arch=x86_64
        meson_cpu_family=x86_64
        ;;
    darwin-arm64|mac-arm64)
        target_arch=arm64
        ffmpeg_arch=aarch64
        meson_cpu_family=aarch64
        ;;
    *)
        echo "Unsupported macOS target: $TOOL_TARGET" >&2
        exit 1
        ;;
esac

workspace="${GITHUB_WORKSPACE:-$(pwd)}"
root_dir="$workspace/macos-ffmpeg"
prefix="$root_dir/install"
build_dir="$root_dir/build"
source_dir="$root_dir/sources"
tool_dir="$workspace/build-tools/$TOOL_TARGET"

mkdir -p "$prefix" "$build_dir" "$source_dir"

export CC="clang"
export CXX="clang++"
export MACOSX_DEPLOYMENT_TARGET="11.0"
export CFLAGS="-arch $target_arch -mmacosx-version-min=11.0 -I$prefix/include"
export CXXFLAGS="-arch $target_arch -mmacosx-version-min=11.0 -stdlib=libc++ -I$prefix/include"
export LDFLAGS="-arch $target_arch -mmacosx-version-min=11.0 -L$prefix/lib"
export PKG_CONFIG="$(command -v pkg-config)"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export PKG_CONFIG_SYSROOT_DIR=

git clone --depth 1 https://github.com/freetype/freetype.git "$source_dir/freetype"
git clone --depth 1 https://github.com/fribidi/fribidi.git "$source_dir/fribidi"
git clone --depth 1 https://github.com/harfbuzz/harfbuzz.git "$source_dir/harfbuzz"
git clone --depth 1 https://github.com/libass/libass.git "$source_dir/libass"

cmake -S "$source_dir/freetype" -B "$build_dir/freetype" -G Ninja \
    -DCMAKE_SYSTEM_NAME=Darwin \
    -DCMAKE_OSX_ARCHITECTURES="$target_arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="11.0" \
    -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DFT_BUILD_TESTS=OFF \
    -DFT_DISABLE_ZLIB=TRUE \
    -DFT_DISABLE_BZIP2=TRUE \
    -DFT_DISABLE_PNG=TRUE \
    -DFT_DISABLE_BROTLI=TRUE \
    -DFT_DISABLE_HARFBUZZ=TRUE
cmake --build "$build_dir/freetype"
cmake --install "$build_dir/freetype"

cat > "$build_dir/meson-cross.ini" <<EOF
[binaries]
c = ['clang', '-arch', '$target_arch', '-mmacosx-version-min=11.0']
cpp = ['clang++', '-arch', '$target_arch', '-mmacosx-version-min=11.0', '-stdlib=libc++']
ar = 'ar'
strip = 'strip'
pkg-config = 'pkg-config'

[host_machine]
system = 'darwin'
cpu_family = '$meson_cpu_family'
cpu = '$target_arch'
endian = 'little'
EOF

meson setup "$build_dir/fribidi" "$source_dir/fribidi" \
    --cross-file "$build_dir/meson-cross.ini" \
    --prefix "$prefix" --libdir=lib --buildtype release \
    --default-library static \
    -Dtests=false -Ddocs=false
meson compile -C "$build_dir/fribidi"
meson install -C "$build_dir/fribidi"

meson setup "$build_dir/harfbuzz" "$source_dir/harfbuzz" \
    --cross-file "$build_dir/meson-cross.ini" \
    --prefix "$prefix" --libdir=lib --buildtype release \
    --default-library static \
    -Dfreetype=disabled -Dglib=disabled -Dgobject=disabled \
    -Dcairo=disabled -Dicu=disabled -Dtests=disabled \
    -Ddocs=disabled -Dutilities=disabled \
    -Dsubset=disabled -Draster=disabled -Dvector=disabled -Dgpu=disabled
meson compile -C "$build_dir/harfbuzz"
meson install -C "$build_dir/harfbuzz"

for pc in $(find "$prefix" -name harfbuzz.pc); do
    if grep -q '^Libs.private:' "$pc"; then
        sed -i.bak 's/^Libs.private:.*$/& -lc++/' "$pc" && rm -f "$pc.bak"
    else
        echo 'Libs.private: -lc++' >> "$pc"
    fi
done

(
    cd "$source_dir/libass"
    autoreconf -fiv
    ./configure --host="$target_arch-apple-darwin" --prefix="$prefix" \
        --enable-static --disable-shared \
        --disable-fontconfig --disable-require-system-font-provider \
        --disable-asm
    make -j"$(sysctl -n hw.ncpu)"
    make install
)

VERSION="$(node -p "require('./tools-versions.json').ffmpeg")"
curl --fail --location --retry 5 --retry-all-errors \
    --output "$root_dir/ffmpeg.tar.xz" \
    "https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
tar -xf "$root_dir/ffmpeg.tar.xz" -C "$root_dir"

libass_cflags="$(pkg-config --cflags libass)"
libass_libs="$(pkg-config --static --libs libass)"

cat > "$build_dir/libass-probe.c" << 'EOF'
#include <ass/ass.h>
int main(void) {
    return ass_library_init() == 0;
}
EOF
clang -arch "$target_arch" -mmacosx-version-min=11.0 $libass_cflags "$build_dir/libass-probe.c" \
    $libass_libs -framework CoreFoundation -framework CoreText -framework CoreGraphics -o "$build_dir/libass-probe"

host_arch="$(uname -m)"
configure_args=(
    --prefix="$tool_dir"
    --arch="$ffmpeg_arch"
    --cc=clang
    --enable-gpl
    --enable-libass
    --enable-filter=subtitles
    --enable-videotoolbox
    --enable-static
    --disable-shared
    --disable-debug
    --disable-doc
    --disable-indev=jack
    --pkg-config=pkg-config
    --pkg-config-flags="--static"
    --extra-cflags="-arch $target_arch -mmacosx-version-min=11.0 $libass_cflags -I$prefix/include"
    --extra-ldflags="-arch $target_arch -mmacosx-version-min=11.0 -L$prefix/lib"
    --extra-libs="$libass_libs -framework CoreFoundation -framework CoreVideo -framework CoreMedia -framework VideoToolbox -framework AudioToolbox -framework CoreText -framework CoreGraphics"
)

if [ "$host_arch" != "$target_arch" ]; then
    configure_args+=(--enable-cross-compile --target-os=darwin)
fi

(
    cd "$root_dir/ffmpeg-${VERSION}"
    if ! ./configure "${configure_args[@]}"; then
        tail -n 200 ffbuild/config.log
        exit 1
    fi
    make -j"$(sysctl -n hw.ncpu)"
    make install
)

mkdir -p "$tool_dir"
mv "$tool_dir/bin/ffmpeg" "$tool_dir/ffmpeg"
mv "$tool_dir/bin/ffprobe" "$tool_dir/ffprobe"
rm -rf "$tool_dir/bin" "$tool_dir/share" "$tool_dir/include" "$tool_dir/lib"
chmod 755 "$tool_dir/ffmpeg" "$tool_dir/ffprobe"

case "$TOOL_TARGET" in
    darwin-*)
        alt_target="mac-${TOOL_TARGET#darwin-}"
        mkdir -p "$workspace/build-tools/$alt_target"
        cp -f "$tool_dir/ffmpeg" "$workspace/build-tools/$alt_target/ffmpeg"
        cp -f "$tool_dir/ffprobe" "$workspace/build-tools/$alt_target/ffprobe"
        ;;
    mac-*)
        alt_target="darwin-${TOOL_TARGET#mac-}"
        mkdir -p "$workspace/build-tools/$alt_target"
        cp -f "$tool_dir/ffmpeg" "$workspace/build-tools/$alt_target/ffmpeg"
        cp -f "$tool_dir/ffprobe" "$workspace/build-tools/$alt_target/ffprobe"
        ;;
esac
