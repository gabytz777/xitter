// Deletes the stored copies of other instances' media, which are fetched from their home again when someone views them.
// usage: bun scripts/drop-remote-media.ts

import { migrate, sql } from "../src/db";
import { dropRemoteMedia } from "../src/federation-sync";

await migrate();
const { files, bytes } = await dropRemoteMedia();
console.log(`deleted ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
await sql.close();
