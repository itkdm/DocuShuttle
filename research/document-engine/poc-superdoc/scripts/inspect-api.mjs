import * as sdk from '@superdoc/sdk';

console.log(JSON.stringify({ exports: Object.keys(sdk).sort() }, null, 2));
