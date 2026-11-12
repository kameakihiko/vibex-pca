#!/bin/bash
# On a Windows runner: one exact mingw-w64 build, checked by its hash, and CC in the job's environment.
set -euo pipefail
name=x86_64-16.2.0-release-win32-seh-ucrt-rt_v14-rev1.7z
sum=c9ae8e4a3afa667b3301dd28c567109d174a0fa0856a2eeaa85a91b89569a50b
cd "$RUNNER_TEMP"
curl -fsSL --retry 3 -o "$name" "https://github.com/niXman/mingw-builds-binaries/releases/download/16.2.0-rt_v14-rev1/$name"
echo "$sum  $name" | sha256sum -c -
7z x -y -bd -omingw "$name" > /dev/null
echo "CC=$(pwd)/mingw/mingw64/bin/gcc.exe" >> "$GITHUB_ENV"
