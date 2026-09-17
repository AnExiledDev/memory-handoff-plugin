import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { elementTable, paneNodes } from "./fixtures.js";
import { paneTree, rowKey } from "../hooks/pane.js";

const view = (openKey = null) => ({
    live: true,
    dbPath: "/tmp/memories.db",
    openKey,
    injections: [
        {
            prompt: "what did we decide about the gate",
            retrievalId: 7,
            chars: 240,
            approxTokens: 60,
            entries: [
                { memoryId: 11, title: "The gate runs once", score: 0.8123, scoreKind: "rerank", body: "# The gate\n\nIt runs on the integrated tree." },
                { memoryId: 12, title: "No untracked deferral", score: 0.4011, scoreKind: "rerank", body: "" },
            ],
        },
    ],
});

const drawn = (openKey, actions) => paneNodes(paneTree(elementTable(), view(openKey), 80, actions));

const elementsOf = (nodes, name) => nodes.filter((node) => node.element === name);

describe("the memory pane", () => {
    it("draws a memory row as text when no press can be answered", () => {
        const nodes = drawn(null, {});

        assert.equal(elementsOf(nodes, "Button").length, 0);
        assert.ok(
            elementsOf(nodes, "Text").some((node) => String(node.props.children).includes("[11] The gate runs once")),
        );
    });

    it("draws a memory row as a pressable button when it can", () => {
        const nodes = drawn(null, { toggle: () => {} });
        const buttons = elementsOf(nodes, "Button");

        assert.equal(buttons.length, 2);
        assert.equal(buttons[0].props.key, rowKey(0, 0));
        assert.equal(buttons[0].props.plain, true);
        assert.ok(String(buttons[0].props.label).includes("[11] The gate runs once"));
    });

    it("starts the focus ring on the first row and nowhere else", () => {
        const buttons = elementsOf(drawn(null, { toggle: () => {} }), "Button");

        assert.equal(buttons[0].props.autoFocus, true);
        assert.equal(buttons[1].props.autoFocus, undefined);
    });

    it("presses through to the toggle with its own key", () => {
        const pressed = [];
        const buttons = elementsOf(drawn(null, { toggle: (key) => pressed.push(key) }), "Button");

        buttons[1].props.onPress();

        assert.deepEqual(pressed, [rowKey(0, 1)]);
    });

    it("draws no body until a row is open, then that row's only", () => {
        assert.equal(elementsOf(drawn(null, { toggle: () => {} }), "Markdown").length, 0);

        const markdown = elementsOf(drawn(rowKey(0, 0), { toggle: () => {} }), "Markdown");

        assert.equal(markdown.length, 1);
        assert.equal(markdown[0].props.text, "# The gate\n\nIt runs on the integrated tree.");
    });

    it("marks the open row and undims it", () => {
        const buttons = elementsOf(drawn(rowKey(0, 0), { toggle: () => {} }), "Button");

        assert.equal(buttons[0].props.dimColor, false);
        assert.ok(String(buttons[0].props.label).includes("v 1."));
        assert.equal(buttons[1].props.dimColor, true);
        assert.ok(String(buttons[1].props.label).includes("> 2."));
    });

    it("says so rather than drawing an empty Markdown when a memory kept no text", () => {
        const nodes = drawn(rowKey(0, 1), { toggle: () => {} });

        assert.equal(elementsOf(nodes, "Markdown").length, 0);
        assert.ok(
            elementsOf(nodes, "Text").some((node) => String(node.props.children).includes("no text stored")),
        );
    });

    it("falls back to text lines on a surface with no Markdown", () => {
        const { Markdown, ...table } = elementTable();
        const nodes = paneNodes(paneTree(table, view(rowKey(0, 0)), 80, { toggle: () => {} }));
        const lines = elementsOf(nodes, "Text").map((node) => String(node.props.children));

        assert.ok(lines.some((line) => line.includes("It runs on the integrated tree.")));
    });

    it("never hands Markdown more than the element takes", () => {
        const long = { ...view(rowKey(0, 0)) };

        long.injections[0].entries[0].body = "x".repeat(12000);

        const markdown = elementsOf(paneNodes(paneTree(elementTable(), long, 80, { toggle: () => {} })), "Markdown");

        assert.equal(markdown[0].props.text.length, 10000);
    });
});
