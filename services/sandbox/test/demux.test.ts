// demux.test.ts - Docker multiplexed-stream demultiplexing (WR-05).
//
// A non-TTY container's logs come back as Docker's multiplexed frame stream:
//   [ STREAM_TYPE(1), 0,0,0, SIZE(4 BE) ][ PAYLOAD ]  (1=stdout, 2=stderr)
// The runner MUST strip the headers and separate the channels — stderr is where
// an untrusted handler's malfunction/abuse signal appears, so the
// malfunction-vs-success classification depends on a clean split.
import { describe, it, expect } from "vitest";
import { demuxDockerLogs } from "../src/runner/demux";

/** Build one Docker multiplexed frame for a given stream + payload. */
function frame(streamType: 1 | 2, payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe("demuxDockerLogs (WR-05)", () => {
  it("separates stdout and stderr and strips the 8-byte frame headers", () => {
    const buf = Buffer.concat([
      frame(1, "hello stdout\n"),
      frame(2, "error on stderr\n"),
      frame(1, "more stdout\n"),
    ]);
    const out = demuxDockerLogs(buf);
    expect(out.stdout).toBe("hello stdout\nmore stdout\n");
    expect(out.stderr).toBe("error on stderr\n");
    // No embedded frame-header NUL byte leaked into the demuxed text.
    expect(out.stdout.includes(String.fromCharCode(0))).toBe(false);
    expect(out.stderr.includes(String.fromCharCode(0))).toBe(false);
  });

  it("captures stderr distinctly even when there is no stdout (malfunction signal)", () => {
    const buf = frame(2, "Traceback: handler crashed");
    const out = demuxDockerLogs(buf);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("Traceback: handler crashed");
  });

  it("falls back to raw stdout for a non-multiplexed (TTY) stream", () => {
    // A raw byte stream with no valid frame header => treat as stdout, never throw.
    const raw = Buffer.from("plain tty output with no header", "utf8");
    const out = demuxDockerLogs(raw);
    expect(out.stdout).toBe("plain tty output with no header");
    expect(out.stderr).toBe("");
  });

  it("handles an empty buffer", () => {
    const out = demuxDockerLogs(Buffer.alloc(0));
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("");
  });
});
