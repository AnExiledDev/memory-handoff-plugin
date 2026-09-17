import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BODY_CAP, TITLE_CAP, parseReply } from "../hooks/parse.js";

const block = (...lines) => ["Here you go.", "", "<memories>", ...lines, "</memories>", ""].join("\n");

const row = (extra = {}) =>
    JSON.stringify({
        type: "project",
        title: "the monitor tick is the deploy",
        body: "merging to main goes live on the next five minute cron pull, not on merge",
        importance: 4,
        ...extra,
    });

describe("parseReply", () => {
    it("reads every row of a whole reply, and carries the optional hint", () => {
        const parsed = parseReply(block(row(), row({ type: "feedback", supersedes_hint: "an older note about batching" })));

        assert.equal(parsed.hadBlock, true);
        assert.equal(parsed.hitCap, null);
        assert.deepEqual(parsed.rejected, []);
        assert.equal(parsed.rows.length, 2);
        assert.equal(parsed.rows[0].type, "project");
        assert.equal(parsed.rows[0].supersedesHint, null);
        assert.equal(parsed.rows[1].supersedesHint, "an older note about batching");
    });

    it("ignores keys the schema does not store rather than refusing the row", () => {
        const parsed = parseReply(block(row({ why: "because the model felt like saying so" })));

        assert.equal(parsed.rows.length, 1);
        assert.equal(parsed.rows[0].why, undefined);
    });

    it("reads a reply cut off mid-row as a truncated row, keeping the whole ones", () => {
        const parsed = parseReply(["<memories>", row(), '{"type":"project","title":"half a'].join("\n"));

        assert.equal(parsed.hadBlock, true);
        assert.equal(parsed.rows.length, 1);
        assert.equal(parsed.hitCap, "truncated row");
        assert.deepEqual(
            parsed.rejected.map((entry) => entry.reason),
            ["not JSON"],
        );
    });

    it("reads a reply cut off between rows as length, with nothing rejected", () => {
        const parsed = parseReply(["<memories>", row(), row(), ""].join("\n"));

        assert.equal(parsed.rows.length, 2);
        assert.deepEqual(parsed.rejected, []);
        assert.equal(parsed.hitCap, "length");
    });

    it("refuses a type outside the four, naming it back", () => {
        const parsed = parseReply(block(row({ type: "insight" })));

        assert.deepEqual(parsed.rows, []);
        assert.deepEqual(parsed.rejected, [{ line: 4, reason: 'unknown type "insight"' }]);
    });

    it("refuses an importance outside 1 to 5, and a fractional one", () => {
        const parsed = parseReply(block(row({ importance: 9 }), row({ importance: 2.5 })));

        assert.deepEqual(parsed.rows, []);
        assert.deepEqual(
            parsed.rejected.map((entry) => entry.reason),
            ["importance 9 is not a whole number from 1 to 5", "importance 2.5 is not a whole number from 1 to 5"],
        );
    });

    it("refuses a body over the schema's cap instead of clipping it", () => {
        const parsed = parseReply(block(row({ body: "x".repeat(BODY_CAP + 1) })));

        assert.deepEqual(parsed.rows, []);
        assert.match(parsed.rejected[0].reason, new RegExp(`^body is ${BODY_CAP + 1} characters, over the ${BODY_CAP}`, "u"));
    });

    it("refuses a title over the schema's cap the same way", () => {
        const parsed = parseReply(block(row({ title: "t".repeat(TITLE_CAP + 1) })));

        assert.deepEqual(parsed.rows, []);
        assert.match(parsed.rejected[0].reason, /^title is 201 characters, over the 200/u);
    });

    it("reads an empty block as the legitimate answer it is", () => {
        const parsed = parseReply(block());

        assert.equal(parsed.hadBlock, true);
        assert.deepEqual(parsed.rows, []);
        assert.deepEqual(parsed.rejected, []);
        assert.equal(parsed.hitCap, null);
    });

    it("reads prose with no block as one rejection, and never as an empty answer", () => {
        const parsed = parseReply("I would rather not. Nothing here seemed worth keeping.");

        assert.equal(parsed.hadBlock, false);
        assert.deepEqual(parsed.rejected, [{ line: 0, reason: "no block" }]);
        assert.equal(parsed.hitCap, null);
    });

    it("never throws, whatever it is handed", () => {
        for (const input of [undefined, null, 42, "", "<memories>", "<memories>\nnull\n</memories>", "<memories>\n[]\n</memories>"]) {
            assert.doesNotThrow(() => parseReply(input));
        }

        assert.equal(parseReply("<memories>\n[]\n</memories>").rejected[0].reason, "not an object");
    });

    it("stays linear in the length of the reply", () => {
        const many = (count) => parseReply(block(...Array.from({ length: count }, () => row())));
        const time = (count) => {
            const started = process.hrtime.bigint();

            many(count);

            return Number(process.hrtime.bigint() - started);
        };

        time(2000);

        const small = Math.max(time(2000), 1);
        const large = time(20_000);

        // Ten times the rows inside a generous factor of ten. A quadratic scan
        // would be about a hundred times slower and would spend the hook's own
        // ten second dispatch budget.
        assert.ok(large < small * 40, `20k rows took ${large / small} times as long as 2k`);
    });
});
