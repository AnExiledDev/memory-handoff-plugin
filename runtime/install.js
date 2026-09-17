/**
 * The install step: `bun runtime/install.js`.
 *
 * Two halves, dependencies then weights, and neither of them is ever run by a
 * hook. A marketplace install copies this directory and runs nothing, so the
 * `node_modules` the runtime imports is absent; 166 MB of weights are not in
 * this repository either. Downloading either one inside a compaction is not
 * something anybody consented to, so this is a command a person runs, once, and
 * until they have run it the runtime answers `ready: false` and retrieval
 * degrades to FTS5-only.
 *
 * That "never from a hook" is enforced rather than documented: importing this
 * file throws, so the only way to reach either download is to run it.
 *
 * The halves are ordered and the order is load-bearing. Weights with no engine
 * to load them are 166 MB of nothing, so a failed `bun install` stops the run
 * and says which half failed rather than leaving somebody with a full models
 * directory and a runtime that still cannot come up.
 *
 * Every weight file is pinned by commit and by sha256 in `models.json`. A
 * digest that disagrees is a failure, not a warning: these files are executed
 * as a model graph and the repository they come from is not ours.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS, RUNTIME_DEPENDENCY, defaultModelsDir, filesFor } from "./infer.js";

if (!import.meta.main) {
    throw new Error(
        "memory-handoff: runtime/install.js is a command, not a module. Dependencies and weights are installed out of band, never from a hook.",
    );
}

const HUB = "https://huggingface.co";

/** The plugin directory, taken from this file rather than from the cwd: the copy being installed is the one this file sits in. */
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = new Set(process.argv.slice(2));
const wantAllDtypes = args.has("--all-dtypes");
const force = args.has("--force");
const modelsDir = defaultModelsDir();

installDependencies();

console.log(`\nmemory-handoff weights -> ${modelsDir}`);

let downloaded = 0;
let verified = 0;

for (const role of ["embed", "rerank"]) {
    const spec = MODELS[role];
    const wanted = wantAllDtypes ? spec.files : matching(spec, spec.shippedDtype);

    console.log(`\n${spec.id}  ${spec.licence}  revision ${spec.revision.slice(0, 12)}`);

    for (const file of wanted) {
        const target = join(modelsDir, spec.id, file.path);
        const already = !force && intact(target, file);

        if (!already) {
            await download(`${HUB}/${spec.id}/resolve/${spec.revision}/${file.path}`, target, file);
            downloaded += 1;
        } else {
            verified += 1;
        }

        console.log(`  ${already ? "have" : "got "} ${file.path.padEnd(26)} ${mb(file.bytes)}`);
    }

    console.log(`  total ${mb(wanted.reduce((sum, file) => sum + file.bytes, 0))}`);
}

console.log(`\n${downloaded} downloaded, ${verified} already present and verified.`);
console.log("Start the runtime with: bun runtime/serve.js");

/**
 * The dependency half: `bun install` into the plugin directory this file lives
 * in, which is the copy the daemon will be started from. Production
 * dependencies only, and from the committed lockfile, so this can never pull a
 * version the tests never saw.
 *
 * Already installed is a no-op, and that matters more than it looks: the second
 * run of this command is the common one, and a machine with no network must
 * still get through it to the weights check.
 *
 * @returns {void}
 */
function installDependencies() {
    const modules = join(PLUGIN_DIR, "node_modules");
    const installed = join(modules, RUNTIME_DEPENDENCY, "package.json");

    console.log(`memory-handoff dependencies -> ${modules}`);

    if (existsSync(installed)) {
        console.log(`  have ${RUNTIME_DEPENDENCY}`);

        return;
    }

    const result = Bun.spawnSync([process.execPath, "install", "--production", "--frozen-lockfile"], {
        cwd: PLUGIN_DIR,
        stdio: ["ignore", "inherit", "inherit"],
    });

    if (!result.success) {
        throw new Error(
            `memory-handoff: the dependency half failed. \`bun install --production --frozen-lockfile\` exited ${result.exitCode} in ${PLUGIN_DIR}, so no weights were fetched. Check the network and run bun runtime/install.js again.`,
        );
    }

    if (!existsSync(installed)) {
        throw new Error(
            `memory-handoff: the dependency half reported success and ${installed} is still not there, so no weights were fetched.`,
        );
    }

    console.log(`  got  ${RUNTIME_DEPENDENCY}`);
}

/**
 * The files of one model at one dtype. `filesFor` answers paths relative to the
 * models directory, and the download needs the entries themselves.
 *
 * @param {{ id: string, files: { path: string, dtype?: string, bytes: number, sha256: string }[] }} spec
 * @param {string} dtype
 */
function matching(spec, dtype) {
    const paths = new Set(filesFor(spec, /** @type {any} */ (dtype)).map((relative) => relative.slice(spec.id.length + 1)));

    return spec.files.filter((file) => paths.has(file.path));
}

/**
 * Whether a file on disk is already the pinned one. The size is checked first
 * because hashing 133 MB to find out it is 700 bytes long is a waste.
 *
 * @param {string} path
 * @param {{ bytes: number, sha256: string }} file
 * @returns {boolean}
 */
function intact(path, file) {
    try {
        if (statSync(path).size !== file.bytes) {
            return false;
        }
    } catch {
        return false;
    }

    return createHash("sha256").update(readFileSync(path)).digest("hex") === file.sha256;
}

/**
 * Downloads to a temporary name and renames on success, so a killed install
 * leaves nothing that looks like a complete file.
 *
 * @param {string} url
 * @param {string} target
 * @param {{ bytes: number, sha256: string }} file
 * @returns {Promise<void>}
 */
async function download(url, target, file) {
    mkdirSync(dirname(target), { recursive: true });

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`memory-handoff: ${url} answered ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");

    if (digest !== file.sha256) {
        throw new Error(
            `memory-handoff: ${url} hashed ${digest}, and models.json pins ${file.sha256}. Nothing was written.`,
        );
    }

    const staged = `${target}.partial`;

    await Bun.write(staged, bytes);

    try {
        renameSync(staged, target);
    } catch (error) {
        rmSync(staged, { force: true });

        throw error;
    }
}

/** @param {number} bytes @returns {string} */
function mb(bytes) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
}
