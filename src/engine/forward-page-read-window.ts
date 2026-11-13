import type { FileHandle } from 'node:fs/promises';
import { readFileHandle, type ReadWaitObserver } from './snapshot-fingerprint';

/** Query-local bounded read-ahead; all filesystem reads retain the caller's allowance. */
export class ForwardPageReadWindow {
  private start = 0n;
  private bytes = Buffer.alloc(0);
  private readonly handle: FileHandle;
  private readonly fileSize: bigint;
  private readonly maximumBytes: number;

  constructor(handle: FileHandle, fileSize: bigint, maximumBytes: number) {
    this.handle = handle;
    this.fileSize = fileSize;
    this.maximumBytes = maximumBytes;
  }

  async read(
    start: bigint,
    length: number,
    recordSpan: number,
    guard: () => void,
    onReadWait?: ReadWaitObserver,
  ): Promise<Buffer | undefined> {
    guard();
    if (
      length <= 0
      || length > this.maximumBytes
      || recordSpan < length
      || recordSpan * 2 > this.maximumBytes
      || start < 0n
    ) return undefined;
    const end = start + BigInt(length);
    if (end > this.fileSize) return undefined;

    const windowEnd = this.start + BigInt(this.bytes.byteLength);
    if (start >= this.start && end <= windowEnd) {
      guard();
      return this.bytes.subarray(Number(start - this.start), Number(end - this.start));
    }

    const remaining = this.fileSize - start;
    if (remaining <= 0n) return undefined;
    const readLength = Number(remaining < BigInt(this.maximumBytes) ? remaining : BigInt(this.maximumBytes));
    const buffer = Buffer.allocUnsafe(readLength);
    guard();
    const bytesRead = await readFileHandle(this.handle, buffer, 0, readLength, start, onReadWait);
    guard();
    this.start = start;
    this.bytes = buffer.subarray(0, bytesRead);
    if (bytesRead < length) return undefined;
    return this.bytes.subarray(0, length);
  }
}
