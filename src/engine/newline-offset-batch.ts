import {
  OFFSET_PAGE_CAPACITY,
  type NewlineOffsetBatch,
  type OffsetPage,
} from './newline-scanner-types';

export class PackedNewlineOffsets implements NewlineOffsetBatch {
  readonly count: number;
  private readonly pages: readonly OffsetPage[];

  constructor(pages: readonly OffsetPage[]) {
    this.pages = pages;
    this.count = pages.reduce((total, page) => total + page.length, 0);
  }

  forEach(visitor: (offset: number) => void): void {
    for (const page of this.pages) {
      for (let index = 0; index < page.length; index += 1) {
        const offset = page.values[index];
        if (offset !== undefined) visitor(offset);
      }
    }
  }
}

export class OffsetBatchBuilder {
  private readonly pages: OffsetPage[] = [];
  private current = new Uint32Array(OFFSET_PAGE_CAPACITY);
  private length = 0;

  push(offset: number): void {
    if (this.length === this.current.length) this.flush();
    this.current[this.length] = offset;
    this.length += 1;
  }

  finish(): PackedNewlineOffsets {
    this.flush();
    return new PackedNewlineOffsets(this.pages);
  }

  private flush(): void {
    if (this.length === 0) return;
    this.pages.push({ values: this.current, length: this.length });
    this.current = new Uint32Array(OFFSET_PAGE_CAPACITY);
    this.length = 0;
  }
}
