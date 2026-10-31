// Tiny assertion helper for the review tests: prints PASS/FAIL, exits 1 on any FAIL.
let failed = 0;
exports.check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? '  [' + detail + ']' : '')); if (!ok) failed++; };
exports.done = () => { console.log(failed ? `${failed} FAILED` : 'ALL PASSED'); process.exit(failed ? 1 : 0); };
exports.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
