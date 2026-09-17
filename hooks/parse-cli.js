#!/usr/bin/env bun
/**
 * `parseReply` on stdin, JSON on stdout.
 *
 * The bench is Python and the parser is JavaScript, and a second parser written
 * in Python to grade the first one would be a bench that measures the wrong
 * thing the first time the two disagree. So there is one parser and the bench
 * shells this.
 *
 *     bun hooks/parse-cli.js < reply.txt
 */

import { parseReply } from "./parse.js";

const text = await new Response(Bun.stdin.stream()).text();

process.stdout.write(`${JSON.stringify(parseReply(text))}\n`);
