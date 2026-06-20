// demux.ts - demultiplex Docker's multiplexed log stream into stdout/stderr.
//
// A non-TTY container's `container.logs({stdout,stderr})` returns Docker's
// MULTIPLEXED stream: a sequence of 8-byte-header frames
//   [ STREAM_TYPE (1 byte), 0, 0, 0, SIZE (4 bytes, big-endian) ][ PAYLOAD ]
// where STREAM_TYPE is 0=stdin, 1=stdout, 2=stderr. Casting the raw buffer to a
// string and assigning it all to `stdout` (with empty `stderr`) yields corrupted
// text (embedded frame headers) and silently DROPS the stdout/stderr split. For
// an untrusted handler, stderr is exactly where malfunction/abuse signal appears,
// so the malfunction-vs-success classification depends on a clean split (WR-05).
//
// This decoder strips the frame headers and routes each payload to the correct
// channel. A TTY container (no multiplexing) emits a raw byte stream with no
// header; we detect that and return the whole buffer as stdout.

/** Demultiplexed Docker logs: frame headers stripped, channels separated. */
export interface DemuxedLogs {
  stdout: string;
  stderr: string;
}

/** Docker multiplexed-frame header length (1 type byte + 3 pad + 4 size bytes). */
const HEADER_LEN = 8;

/**
 * Demultiplex a Docker multiplexed log buffer into `{stdout, stderr}` (utf8),
 * stripping the 8-byte frame headers. If the buffer is not a valid multiplexed
 * stream (a TTY container emits a raw, header-less byte stream), the whole buffer
 * is returned as stdout (best-effort, never throws).
 */
export function demuxDockerLogs(buf: Buffer): DemuxedLogs {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  let offset = 0;
  while (offset + HEADER_LEN <= buf.length) {
    const streamType = buf[offset];
    const size = buf.readUInt32BE(offset + 4);
    const payloadStart = offset + HEADER_LEN;
    const payloadEnd = payloadStart + size;

    // A malformed/truncated frame (or a non-multiplexed TTY stream that happens to
    // be longer than its first "size" claims) means this is NOT a clean multiplexed
    // buffer. Fall back to treating the entire buffer as raw stdout.
    if (
      (streamType !== 0 && streamType !== 1 && streamType !== 2) ||
      payloadEnd > buf.length
    ) {
      return { stdout: buf.toString("utf8"), stderr: "" };
    }

    const payload = buf.subarray(payloadStart, payloadEnd);
    if (streamType === 2) {
      stderr.push(payload);
    } else {
      // stdin (0) and stdout (1) both route to stdout for our purposes.
      stdout.push(payload);
    }
    offset = payloadEnd;
  }

  // Trailing bytes shorter than a header => not a clean multiplexed stream; if we
  // parsed nothing at all, treat the whole buffer as raw stdout.
  if (stdout.length === 0 && stderr.length === 0) {
    return { stdout: buf.toString("utf8"), stderr: "" };
  }

  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
