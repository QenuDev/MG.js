/** The transport seam both clients implement. */

export type { Unsubscribe } from '../unsubscribe.js';
export type {
  LifecycleTimeouts,
  ObservableTransport,
  Transport,
  TransportCloseInfo,
  TransportKind,
  TransportState,
} from './seam.js';
export { DEFAULT_LIFECYCLE_TIMEOUTS } from './seam.js';
