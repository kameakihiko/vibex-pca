#!/bin/bash
# Builds vibex-askpass.exe from source into native/askpass-win/build. CC is a pinned mingw-w64 gcc: toolchain-windows.sh on a Windows
# runner, apt in scripts/fence-windows-installer.sh on the fence. Never a committed binary. Run from electron/.
set -euo pipefail
here=native/askpass-win
out=$here/build
: "${CC:=x86_64-w64-mingw32-gcc}"
"$CC" --version | head -n 1
mkdir -p "$out"
# No C runtime at all (stricter than a static one): only system DLLs are left to depend on, and no CRT start code runs before ap_entry.
# --dynamicbase, --high-entropy-va: ASLR. --nxcompat: DEP. --subsystem,windows: no console, so no window can flash.
# --no-insert-timestamp: the same source gives the same bytes in a run.
"$CC" -std=gnu11 -Os -Wall -Wextra -Werror=implicit-function-declaration -Werror=int-conversion -Werror=incompatible-pointer-types \
  -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-tree-loop-distribute-patterns -fno-ident -s -nostdlib -nostartfiles \
  -Wl,-e,ap_entry -Wl,--subsystem,windows -Wl,--dynamicbase,--high-entropy-va,--nxcompat,--enable-reloc-section,--no-insert-timestamp \
  -o "$out/vibex-askpass.exe" "$here/vibex-askpass.c" -lshell32 -lkernel32 -lgcc
node scripts/check-askpass-exe.cjs "$out/vibex-askpass.exe"
