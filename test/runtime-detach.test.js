import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detachedArgv } from "../runtime/detach.js";

describe("a detached start gets its own session", () => {
    it("puts setsid in front when the box has it", () => {
        assert.deepEqual(detachedArgv(["bun", "serve.js"], () => "/usr/bin/setsid"), ["setsid", "bun", "serve.js"]);
    });

    it("starts the argv bare when it does not", () => {
        assert.deepEqual(detachedArgv(["bun", "serve.js"], () => null), ["bun", "serve.js"]);
    });
});
