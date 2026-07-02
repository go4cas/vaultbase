import { describe, expect, it } from "bun:test";
import { log } from "../core/log.ts";

/** Capture raw lines written to a std stream during `fn`. */
function capture(stream: "stdout" | "stderr", fn: () => void): string[] {
  const lines: string[] = [];
  const target = process[stream] as unknown as { write: (chunk: string) => boolean };
  const orig = target.write;
  target.write = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    target.write = orig;
  }
  return lines;
}

describe("log", () => {
  it("writes errors to stderr with a serialized Error and level/ts/ctx", () => {
    const lines = capture("stderr", () => log.error("boom", { err: new Error("nope"), id: 7 }));
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0]!);
    expect(e.level).toBe("error");
    expect(e.msg).toBe("boom");
    expect(typeof e.ts).toBe("string");
    expect(e.id).toBe(7);
    // A plain JSON.stringify would emit `{}` for an Error — the replacer must not.
    expect(e.err.name).toBe("Error");
    expect(e.err.message).toBe("nope");
  });

  it("writes info to stdout", () => {
    const lines = capture("stdout", () => log.info("hi"));
    expect(JSON.parse(lines[0]!).level).toBe("info");
  });

  it("suppresses debug below the default info threshold", () => {
    const lines = capture("stdout", () => log.debug("verbose"));
    expect(lines).toHaveLength(0);
  });
});
