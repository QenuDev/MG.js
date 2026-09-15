/**
 * The one declaration of "a function that detaches a listener".
 *
 * `Unsubscribe` is the return type of every subscription in this repository: the transport seam
 * (`onMessage`/`onOpen`/`onClose`), the store (`subscribe`/`subscribeAll`), the emitter, and the events
 * on all four client classes. It was declared three times: here, in `transport/seam.ts`, and again in
 * `@mg.js/headless`'s `room-socket.ts`. That forced `state/index.ts` to carry a comment explaining
 * which of the two identical names it was *not* exporting. A type with three homes is three chances to
 * change one and not the others, and a consumer importing both packages got a nominal clash for what is
 * one concept.
 */
export type Unsubscribe = () => void;
