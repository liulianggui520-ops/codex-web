import {verifyRelease} from '../server/release.mjs';
import {fileURLToPath} from 'node:url';
const manifest=await verifyRelease(process.argv[2]||fileURLToPath(new URL('..',import.meta.url)));
console.log(`Verified ${manifest.releaseId}: ${Object.keys(manifest.files).length} files`);
