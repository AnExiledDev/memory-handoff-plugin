/**
 * Starting a process that outlives the one starting it.
 *
 * `Bun.spawn` puts the child in the parent's session and process group, so a
 * daemon started from inside a Claude Code session dies with that session's
 * terminal: the pty closing sends SIGHUP to the whole foreground group, and the
 * daemon goes with it. Measured on 2026-09-17 by starting a retrieval under
 * `script` and closing it: zero daemons left. Every session then paid a cold
 * start, and a prompt-time retrieval never had a warm runtime to find.
 *
 * `setsid` gives the child a session of its own, out of reach of the hangup.
 * When it is not on the PATH the child is started bare, which is the old
 * behaviour, and `runtime/serve.js` ignoring SIGHUP covers most of the gap.
 */

/**
 * The argv with `setsid` in front of it when the box has one.
 *
 * @param {string[]} argv
 * @param {(name: string) => string | null} [which]
 * @returns {string[]}
 */
export const detachedArgv = (argv, which = (name) => Bun.which(name)) => (which("setsid") === null ? argv : ["setsid", ...argv]);

/**
 * Starts the argv detached: own session where possible, every descriptor
 * ignored, the handle unref'd so this process can exit without it.
 *
 * @param {string[]} argv
 * @returns {void}
 */
export const spawnDetached = (argv) => {
    const child = Bun.spawn(detachedArgv(argv), {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
    });

    child.unref();
};
