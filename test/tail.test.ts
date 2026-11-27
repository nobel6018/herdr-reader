import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TailReader, readLastLines } from "../src/tail.ts";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "herdr-reader-tail-"));
  file = path.join(dir, "t.jsonl");
  await writeFile(file, "");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TailReader", () => {
  test("returns each appended line once, in order", async () => {
    const tail = new TailReader(file, 0);
    await appendFile(file, '{"n":1}\n{"n":2}\n');
    expect(await tail.read()).toEqual({ lines: ['{"n":1}', '{"n":2}'], reset: false });
    await appendFile(file, '{"n":3}\n');
    expect(await tail.read()).toEqual({ lines: ['{"n":3}'], reset: false });
    expect(await tail.read()).toEqual({ lines: [], reset: false });
  });

  test("holds a line that is still being written until its newline arrives", async () => {
    const tail = new TailReader(file, 0);
    await appendFile(file, '{"text":"hal');
    expect((await tail.read()).lines).toEqual([]);
    await appendFile(file, 'f"}\n');
    expect((await tail.read()).lines).toEqual(['{"text":"half"}']);
  });

  test("keeps a multi-byte character that is split across two writes", async () => {
    const tail = new TailReader(file, 0);
    const bytes = Buffer.from('{"text":"한글"}\n');
    await appendFile(file, bytes.subarray(0, 11));
    expect((await tail.read()).lines).toEqual([]);
    await appendFile(file, bytes.subarray(11));
    expect((await tail.read()).lines).toEqual(['{"text":"한글"}']);
  });

  test("after truncation it starts over from the beginning and says so", async () => {
    await appendFile(file, '{"n":1}\n{"n":2}\n');
    const tail = new TailReader(file, 0);
    await tail.read();
    await writeFile(file, '{"n":9}\n');
    expect(await tail.read()).toEqual({ lines: ['{"n":9}'], reset: true });
  });

  test("reads in parallel do not return a line twice", async () => {
    const tail = new TailReader(file, 0);
    await appendFile(file, "a\nb\n");
    const chunks = await Promise.all([tail.read(), tail.read(), tail.read()]);
    expect(chunks.flatMap((c) => c.lines)).toEqual(["a", "b"]);
  });
});

describe("readLastLines", () => {
  test("drops the cut first line and the unfinished last line, and a tail from its offset finishes that line", async () => {
    await appendFile(file, "first-long-line\nsecond\nthird\nunfini");
    const last = await readLastLines(file, 20);
    expect(last.lines).toEqual(["second", "third"]);
    expect(last.whole).toBe(false);
    const tail = new TailReader(file, last.offset);
    await appendFile(file, "shed\n");
    expect((await tail.read()).lines).toEqual(["unfinished"]);
  });

  test("a small file is read whole", async () => {
    await appendFile(file, "a\nb\n");
    expect(await readLastLines(file, 1024)).toEqual({ lines: ["a", "b"], offset: 4, whole: true });
  });
});
