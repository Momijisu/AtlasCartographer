#!/bin/bash
# Runs every browser test against a local copy of the app, with OneDrive
# mocked (mock.js). Usage, from anywhere:  tests/runall.sh [only these tests…]
# Logs go to tests/out/; screenshots land in tests/ (both ignored by git).
# Exits non-zero if any test fails.
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
mkdir -p out
# Serve the app on :8765 unless something already is.
if ! curl -s -o /dev/null http://localhost:8765/; then
  python3 -m http.server 8765 --directory "$ROOT" >/dev/null 2>&1 &
  SERVER=$!
  trap 'kill $SERVER' EXIT
  sleep 1
fi
TESTS=${*:-$(ls *test.js shapetex.js | sed 's/\.js$//')}
failed=0
for t in $TESTS; do
  timeout 240 node $t.js > out/$t.log 2>&1
  code=$?
  if [ $code = 0 ]; then echo "pass  $t"; else echo "FAIL  $t (exit $code, see tests/out/$t.log)"; failed=$((failed + 1)); fi
done
echo "$failed failed"
[ $failed = 0 ]
