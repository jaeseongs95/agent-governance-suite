#!/bin/bash
set -u
V=$1; D=/tmp/nodes; mkdir -p $D; cd $D
F=node-$V-linux-x64.tar.xz
for i in 1 2 3; do curl -sSfL --max-time 300 -o $F https://nodejs.org/dist/$V/$F && break; sleep $((2**i)); done
curl -sSfL --max-time 60 -o SHASUMS256-$V.txt https://nodejs.org/dist/$V/SHASUMS256.txt
grep " $F\$" SHASUMS256-$V.txt | tee /dev/stderr | sha256sum -c - || { echo SHA_FAIL; exit 1; }
tar xf $F && echo installed $D/node-$V-linux-x64 && $D/node-$V-linux-x64/bin/node -v
