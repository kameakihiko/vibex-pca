#!/bin/bash
# Builds vibex-presence.exe (the Windows Hello check before a saved secret) from source into native/presence-win/build, with the
# same pinned mingw-w64 gcc (CC) and the same flags as native/askpass-win/build.sh. Never a committed binary. Run from electron/.
set -euo pipefail
here=native/presence-win
out=$here/build
: "${CC:=x86_64-w64-mingw32-gcc}"
"$CC" --version | head -n 1
mkdir -p "$out"
# No C runtime at all: only system DLLs are left to depend on. combase.dll is loaded from System32 at run time, so the imports
# stay kernel32 and shell32. --dynamicbase, --high-entropy-va: ASLR. --nxcompat: DEP. --subsystem,windows: no console window.
# --no-insert-timestamp: the same source gives the same bytes in a run.
"$CC" -std=gnu11 -Os -Wall -Wextra -Werror=implicit-function-declaration -Werror=int-conversion -Werror=incompatible-pointer-types \
  -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-tree-loop-distribute-patterns -fno-ident -s -nostdlib -nostartfiles \
  -Wl,-e,vp_entry -Wl,--subsystem,windows -Wl,--dynamicbase,--high-entropy-va,--nxcompat,--enable-reloc-section,--no-insert-timestamp \
  -o "$out/vibex-presence.exe" "$here/vibex-presence.c" -lshell32 -lkernel32 -lgcc
node scripts/check-presence-exe.cjs "$out/vibex-presence.exe"
