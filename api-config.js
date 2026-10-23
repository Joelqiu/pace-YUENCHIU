// The Pages site must call the isolated Worker while this branch is under test.
// Switch this to the production Worker only as part of the later, reviewed merge.
window.PACE_API_BASE = 'https://pace-yuanchiu-merge-test.pace-yuenchiu.workers.dev';
