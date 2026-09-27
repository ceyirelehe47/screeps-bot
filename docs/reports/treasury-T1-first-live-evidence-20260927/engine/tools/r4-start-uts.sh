#!/bin/sh
set -eu
exec unshare --uts --fork /bin/sh -c '
  hostname shard1
  exec runuser -u screepslab -- /srv/screeps-treasury-t1/runtime/node22/bin/node \
    /srv/screeps-treasury-t1/server/node_modules/screeps/bin/screeps.js start
'
