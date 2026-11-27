import type { ObservationEvent, ObservationSink } from './types';

/**
 * What `observationChannel` needs of a channel: the two members of a Node `diagnostics_channel` channel that it uses.
 * Written out so the package imports nothing from Node and depends on no tracing SDK: `diagnostics_channel.channel(name)`
 * is one, and so is any object with the same two members.
 */
export interface ObservationChannel {
  publish(message: unknown): void;
  /** When the channel says it has no subscriber (`false`), nothing is published. Absent: published. */
  readonly hasSubscribers?: boolean;
}

/**
 * A sink that forwards each event of a container to `channel`, as it is: the very frozen object, nothing copied, nothing
 * added. It skips an event while the channel says it has no subscriber, and asks again at each event.
 *
 * A Node `diagnostics_channel` channel fits as it is: pass the channel to `observationChannel` and the result to
 * `container.observe`. The full example is in `docs/guide/observability.md`.
 *
 * A failure of the channel is not caught here: the container isolates every sink, so it never reaches the service.
 */
export function observationChannel(channel: ObservationChannel): ObservationSink {
  return (event: Readonly<ObservationEvent>): void => {
    if (channel.hasSubscribers === false) return;
    channel.publish(event);
  };
}
