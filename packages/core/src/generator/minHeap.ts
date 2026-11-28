/**
 * Binary heap of step indices. The smaller index leaves first.
 * `stats.comparisons` counts every comparison, made by the one `earlier` helper.
 */
class MinIndexQueue {
  private readonly values: number[] = [];

  constructor(private readonly stats?: { comparisons: number }) {}

  get size(): number {
    return this.values.length;
  }

  push(value: number): void {
    let index = this.values.length;
    this.values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentValue = this.values[parent];
      if (parentValue === undefined || this.earlier(parentValue, value)) break;
      this.values[index] = parentValue;
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): number {
    const first = this.values[0];
    if (first === undefined) throw new Error('empty queue');
    const last = this.values.pop();
    if (last === undefined || this.values.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < this.values.length) {
      let child = index * 2 + 1;
      const right = child + 1;
      const leftValue = this.values[child];
      const rightValue = this.values[right];
      if (
        right < this.values.length
        && rightValue !== undefined
        && leftValue !== undefined
        && this.earlier(rightValue, leftValue)
      ) {
        child = right;
      }
      const childValue = this.values[child];
      if (childValue === undefined || this.earlier(last, childValue)) break;
      this.values[index] = childValue;
      index = child;
    }
    this.values[index] = last;
    return first;
  }

  private earlier(left: number, right: number): boolean {
    if (this.stats) this.stats.comparisons += 1;
    return left <= right;
  }
}

export { MinIndexQueue };
