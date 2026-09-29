#!/bin/bash
# runs order.txt with 4 concurrent workers, starting runs in seeded order
cd /tmp/ev/scripts
xargs -P 4 -L 1 /tmp/ev/scripts/run-one.sh < order.txt
echo "$(date -u +%FT%TZ) driver done" >> /tmp/ev/runs/driver-events.log
