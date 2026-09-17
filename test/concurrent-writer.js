/**
 * One of the two writers the concurrency test spawns.
 *
 * `bun test/concurrent-writer.js <path> <tag> <n>` opens the same database
 * through the adapter and writes n memories with uuids nobody else will use.
 * Two sessions can compact in the same minute, so two processes writing at once
 * is the case the WAL mode and the busy timeout exist for, and the only honest
 * way to test it is two processes.
 */

import { openMemoryDb, withRetry } from "../schema/bun-sqlite.js";

const [path, tag, howMany] = process.argv.slice(2);
const { db, close } = openMemoryDb(path);

try {
    const insert = db.query(
        `INSERT INTO memories (uuid, project, type, title, body, importance, status, source, created_at, updated_at)
         VALUES (?, 'host/owner/repo', 'project', ?, 'A body written by a concurrent writer.', 3, 'active',
                 '{"kind":"manual"}', '2026-09-16T12:00:00Z', '2026-09-16T12:00:00Z')`,
    );

    for (let n = 0; n < Number(howMany); n += 1) {
        withRetry(() => insert.run(`${tag}-${n}`, `${tag} memory ${n}`));
    }
} finally {
    close();
}
