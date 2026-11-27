import * as diagnosticsChannel from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import * as neosyringe from '../src/index';
import type { ObservationEvent } from '../src/index';

/**
 * O11 (topic 22, step 4) the optional trace adapter. `observationChannel(channel)` is a sink that forwards each event of a
 * container to a channel. It matches a Node `diagnostics_channel` structurally, so the package imports nothing from Node,
 * and it holds no SDK. A channel with `hasSubscribers === false` is skipped, so a build that observes pays nothing when
 * nobody listens.
 */

function event(kind: 'start' | 'end'): ObservationEvent {
  return Object.freeze({ containerId: 'c1', scopeId: 'root', registrationId: 'IA_1', phase: 'construct', kind });
}

/** A channel that records what it is given and answers `hasSubscribers` from a flag the test turns. */
function fakeChannel(initial: boolean | undefined): { published: unknown[]; flag: { value: boolean | undefined }; channel: { publish(message: unknown): void; readonly hasSubscribers?: boolean } } {
  const published: unknown[] = [];
  const flag = { value: initial };
  return {
    published,
    flag,
    channel: {
      publish(message: unknown): void {
        published.push(message);
      },
      get hasSubscribers(): boolean | undefined {
        return flag.value;
      },
    },
  };
}

describe('O11 observationChannel', () => {
  it('O11 forwards each event, as it is and in order, and answers nothing', () => {
    expect(typeof neosyringe.observationChannel, 'observationChannel is exported').toBe('function');
    const fake = fakeChannel(true);
    const sink = neosyringe.observationChannel(fake.channel);
    const start = event('start');
    const end = event('end');
    expect(sink(start)).toBeUndefined();
    expect(sink(end)).toBeUndefined();
    expect(fake.published).toHaveLength(2);
    // The very object the container froze: nothing is copied, nothing is added.
    expect(fake.published[0]).toBe(start);
    expect(fake.published[1]).toBe(end);
  });

  it('O11 skips an event when the channel says it has no subscriber, and asks again at each event', () => {
    expect(typeof neosyringe.observationChannel, 'observationChannel is exported').toBe('function');
    const fake = fakeChannel(false);
    const sink = neosyringe.observationChannel(fake.channel);
    sink(event('start'));
    expect(fake.published).toHaveLength(0);
    fake.flag.value = true;
    sink(event('end'));
    expect(fake.published).toHaveLength(1);
    fake.flag.value = false;
    sink(event('start'));
    expect(fake.published).toHaveLength(1);
  });

  it('O11 forwards when the channel does not say whether it has a subscriber', () => {
    expect(typeof neosyringe.observationChannel, 'observationChannel is exported').toBe('function');
    const fake = fakeChannel(undefined);
    neosyringe.observationChannel(fake.channel)(event('start'));
    expect(fake.published).toHaveLength(1);
  });

  it('O11 a Node diagnostics_channel is a channel: a subscriber receives the events, and no one is told when it leaves', () => {
    expect(typeof neosyringe.observationChannel, 'observationChannel is exported').toBe('function');
    const channel = diagnosticsChannel.channel('neosyringe:test:observation');
    const sink = neosyringe.observationChannel(channel);
    const received: unknown[] = [];
    const listener = (message: unknown): void => {
      received.push(message);
    };
    diagnosticsChannel.subscribe('neosyringe:test:observation', listener);
    try {
      expect(channel.hasSubscribers).toBe(true);
      const start = event('start');
      sink(start);
      expect(received).toEqual([start]);
    } finally {
      diagnosticsChannel.unsubscribe('neosyringe:test:observation', listener);
    }
    expect(channel.hasSubscribers).toBe(false);
    sink(event('end'));
    expect(received).toHaveLength(1);
  });

  it('O11 does not hide a failure of the channel: the container is what isolates a sink', () => {
    expect(typeof neosyringe.observationChannel, 'observationChannel is exported').toBe('function');
    const failure = new Error('channel failure');
    const sink = neosyringe.observationChannel({
      publish(): void {
        throw failure;
      },
    });
    let caught: unknown;
    try {
      sink(event('start'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});
