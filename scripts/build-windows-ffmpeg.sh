#!/usr/bin/env bash

set -euo pipefail

: "${TOOL_TARGET:?TOOL_TARGET must be set}"

case "$TOOL_TARGET" in
win32-x64 | win-x64)
	target=x86_64-w64-mingw32
	ffmpeg_arch=x86_64
	;;
win32-arm64 | win-arm64)
	target=aarch64-w64-mingw32
	ffmpeg_arch=aarch64
	;;
*)
	echo "Unsupported Windows target: $TOOL_TARGET" >&2
	exit 1
	;;
esac

llvm_version=20261020
llvm_archive="llvm-mingw-${llvm_version}-ucrt-ubuntu-22.04-x86_64"
llvm_url="https://github.com/mstorsjo/llvm-mingw/releases/download/${llvm_version}/${llvm_archive}.tar.xz"
llvm_sha256=55064b60b991a1e1e8090b8c2f84e82b22cfe5903d12c159d65064cf5e8ae335
root_dir="$GITHUB_WORKSPACE/windows-ffmpeg"
prefix="$root_dir/install"
build_dir="$root_dir/build"
source_dir="$root_dir/sources"
tool_dir="$GITHUB_WORKSPACE/build-tools/$TOOL_TARGET"

mkdir -p "$prefix" "$build_dir" "$source_dir"

curl --fail --location --retry 5 --retry-all-errors \
	--output "$root_dir/llvm-mingw.tar.xz" "$llvm_url"
echo "$llvm_sha256  $root_dir/llvm-mingw.tar.xz" | sha256sum --check
tar -xJf "$root_dir/llvm-mingw.tar.xz" -C "$root_dir"
toolchain="$root_dir/$llvm_archive"
export PATH="$toolchain/bin:$PATH"

export CC="$target-clang"
export CXX="$target-clang++"
export AR="$target-ar"
export RANLIB="$target-ranlib"
export STRIP="$target-strip"
export WINDRES="$target-windres"

# Provide cross-prefixed pkg-config wrapper/symlink
ln -sf "$(command -v pkg-config)" "$toolchain/bin/$target-pkg-config"

export PKG_CONFIG="$(command -v pkg-config)"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export PKG_CONFIG_SYSROOT_DIR=

git clone --depth 1 https://github.com/freetype/freetype.git "$source_dir/freetype"
git clone --depth 1 https://github.com/fribidi/fribidi.git "$source_dir/fribidi"
git clone --depth 1 https://github.com/harfbuzz/harfbuzz.git "$source_dir/harfbuzz"
git clone --depth 1 https://github.com/libass/libass.git "$source_dir/libass"

cmake -S "$source_dir/freetype" -B "$build_dir/freetype" -G Ninja \
	-DCMAKE_SYSTEM_NAME=Windows \
	-DCMAKE_C_COMPILER="$CC" \
	-DCMAKE_CXX_COMPILER="$CXX" \
	-DCMAKE_RC_COMPILER="$WINDRES" \
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

cat >"$build_dir/meson-cross.ini" <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$AR'
strip = '$STRIP'
windres = '$WINDRES'
pkg-config = 'pkg-config'

[host_machine]
system = 'windows'
cpu_family = '$ffmpeg_arch'
cpu = '$ffmpeg_arch'
endian = 'little'
EOF

meson setup "$build_dir/fribidi" "$source_dir/fribidi" \
	--cross-file "$build_dir/meson-cross.ini" \
	--prefix "$prefix" --buildtype release \
	--default-library static \
	-Dtests=false -Ddocs=false
meson compile -C "$build_dir/fribidi"
meson install -C "$build_dir/fribidi"

meson setup "$build_dir/harfbuzz" "$source_dir/harfbuzz" \
	--cross-file "$build_dir/meson-cross.ini" \
	--prefix "$prefix" --buildtype release \
	--default-library static \
	-Dfreetype=disabled -Dglib=disabled -Dgobject=disabled \
	-Dcairo=disabled -Dicu=disabled -Dtests=disabled \
	-Ddocs=disabled -Dutilities=disabled
meson compile -C "$build_dir/harfbuzz"
meson install -C "$build_dir/harfbuzz"

# HarfBuzz is C++. When built statically and consumed by C projects (like FFmpeg),
# ensure its pkg-config file lists -lc++ in Libs.private so the C++ standard library is linked.
if [ -f "$prefix/lib/pkgconfig/harfbuzz.pc" ]; then
	if grep -q '^Libs.private:' "$prefix/lib/pkgconfig/harfbuzz.pc"; then
		sed -i.bak 's/^Libs.private:.*$/& -lc++/' "$prefix/lib/pkgconfig/harfbuzz.pc" && rm -f "$prefix/lib/pkgconfig/harfbuzz.pc.bak"
	else
		echo 'Libs.private: -lc++' >>"$prefix/lib/pkgconfig/harfbuzz.pc"
	fi
fi

(
	cd "$source_dir/libass"
	autoreconf -fiv
	./configure --host="$target" --prefix="$prefix" \
		--enable-static --disable-shared \
		--disable-fontconfig --disable-directwrite \
		--disable-require-system-font-provider \
		--disable-asm
	make -j"$(nproc)"
	make install
)

VERSION="$(node -p "require('./tools-versions.json').ffmpeg")"
curl --fail --location --retry 5 --retry-all-errors \
	--output "$root_dir/ffmpeg.tar.xz" \
	"https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
tar -xf "$root_dir/ffmpeg.tar.xz" -C "$root_dir"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR=
pkg-config --modversion libass
pkg-config --static --libs libass
libass_cflags="$(pkg-config --cflags libass)"
libass_libs="$(pkg-config --static --libs libass)"
cat >"$build_dir/libass-probe.c" <<'EOF'
#include <ass/ass.h>
int main(void) {
    return ass_library_init() == 0;
}
EOF
"$CC" -static $libass_cflags "$build_dir/libass-probe.c" \
	$libass_libs -o "$build_dir/libass-probe.exe"
(
	cd "$root_dir/ffmpeg-${VERSION}"
	if ! ./configure \
		--prefix="$tool_dir" \
		--target-os=mingw32 --arch="$ffmpeg_arch" \
		--cross-prefix="$target-" \
		--enable-cross-compile --cc="$CC" \
		--enable-gpl --enable-libass --enable-filter=subtitles \
		--enable-static --disable-shared --disable-debug --disable-doc \
		--pkg-config=pkg-config \
		--pkg-config-flags="--static" \
		--extra-cflags="$libass_cflags -I$prefix/include" \
		--extra-ldflags="-static -L$prefix/lib" \
		--extra-libs="-Wl,--start-group $libass_libs -Wl,--end-group"; then
		echo 'FFmpeg configure failed; relevant configuration log:' >&2
		grep -n -A12 -B12 -E 'libass|error:|undefined reference|cannot find' ffbuild/config.log >&2 || cat ffbuild/config.log >&2
		exit 1
	fi
	make -j"$(nproc)"
	make install
)

mkdir -p "$tool_dir"
mv "$tool_dir/bin/ffmpeg.exe" "$tool_dir/ffmpeg.exe"
mv "$tool_dir/bin/ffprobe.exe" "$tool_dir/ffprobe.exe"
rm -rf "$tool_dir/bin" "$tool_dir/share"

case "$TOOL_TARGET" in
win32-*)
	alt_target="win-${TOOL_TARGET#win32-}"
	mkdir -p "$GITHUB_WORKSPACE/build-tools/$alt_target"
	cp -f "$tool_dir/ffmpeg.exe" "$GITHUB_WORKSPACE/build-tools/$alt_target/ffmpeg.exe"
	cp -f "$tool_dir/ffprobe.exe" "$GITHUB_WORKSPACE/build-tools/$alt_target/ffprobe.exe"
	;;
win-*)
	alt_target="win32-${TOOL_TARGET#win-}"
	mkdir -p "$GITHUB_WORKSPACE/build-tools/$alt_target"
	cp -f "$tool_dir/ffmpeg.exe" "$GITHUB_WORKSPACE/build-tools/$alt_target/ffmpeg.exe"
	cp -f "$tool_dir/ffprobe.exe" "$GITHUB_WORKSPACE/build-tools/$alt_target/ffprobe.exe"
	;;
esac
