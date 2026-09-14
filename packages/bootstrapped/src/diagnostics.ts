/**
 * The diagnostic snapshot, as functions of what the client found.
 *
 * ## What this was, and why it moved
 *
 * `BootstrapReport` is the page-shaped diagnostic a bug report wants, and `client.report.detail` is how a
 * caller reads it. Both it and the code that built it used to be private methods of `BootstrappedClient`
 * (Phase 5 Task 5.7e), which had one consequence that mattered: the only way to produce a diagnostic was to
 * build a whole client (a page realm, a storage backend, a protocol core, an attached socket), so the
 * surface a user is told to paste into a bug report was the surface with the least direct coverage in the
 * package. A diagnostic that cannot be exercised in a test is a diagnostic that drifts.
 *
 * The builders are therefore pure functions of {@link DiagnosticsInput} and {@link ReportAxes}, and the
 * client is a thin adapter that gathers those fields. The input interfaces are written out by hand rather
 * than derived with a `Pick` over `BootstrappedClient`: a `Pick` would need `import type` from
 * `client.ts`, which is the circular import this split exists to remove, and a hand-written input turns
 * "someone added a field to the report" into a compile error at the call site instead of a silently
 * missing key.
 *
 * ## The audit's name
 *
 * The structure report calls this split `buildBootstrapReport` (`docs/audit/40-structure-packages.md:174`).
 * It is realized here as two functions: {@link buildDetail} for the page-shaped payload the pre-4.4
 * `report()` returned, and {@link buildReport} for the contract axes wrapped around it. That is the division
 * the 4.4 rename introduced, and the payload is what the interesting assertions are about.
 */

import type { ClientReport, MgError, MgErrorSummary } from '@mg.js/common';
import { summarizeError } from '@mg.js/common';
import type { AttachmentReport } from './attach/detect.js';
import { BUNDLE_VERSION } from './build-info.js';

/** A snapshot of what the client found, for diagnostics and bug reports. */
export interface BootstrapReport {
  version: string;
  attachment: AttachmentReport;
  storage: { backend: string; durable: boolean; roundTrips: boolean };
  render: { enabled: boolean; initFired: boolean; ctorsRecovered: boolean };
  jotai: { enabled: boolean; atomsSeen: number; setCaptured: boolean };
  catalog: { enabled: boolean; tables: string[] };
  renumbering: { enabled: boolean; owns: boolean; highestSeen: number };
  hasPage: boolean;
}

/**
 * Everything {@link BootstrappedClient.report} publishes: the contract's axes, plus this client's own.
 *
 * The pre-4.4 report, the page-shaped diagnostic a bug report wants, is the whole of
 * {@link BootstrapReport}, kept as `detail` rather than flattened. Nothing it carried is lost and no field
 * was renamed; a caller that used to write `client.report().storage` writes `client.report.detail.storage`.
 */
export interface BootstrappedReport extends ClientReport {
  /** The page-shaped snapshot, exactly as the old `report()` method built it. */
  detail: BootstrapReport;
}

/**
 * Every fact {@link buildDetail} publishes, already resolved by the caller.
 *
 * The polarity rule applies here rather than at the call site: `enabled`, `initFired` and `ctorsRecovered`
 * are *decided* by the client (a disabled feature, a fired hook, a recovered constructor) and handed over
 * as booleans, so this module never has to know what "enabled" means for any of the five features. That is
 * what keeps it importable without a page: it reads no globals, opens nothing, and can be called with
 * literals.
 * @internal
 */
export interface DiagnosticsInput {
  /** The resolved attachment snapshot, or `null` before any attempt has been made. */
  readonly attachment: AttachmentReport | null;
  /** Whether the Pixi constructors were recovered from the page. */
  readonly ctorsRecovered: boolean;
  readonly render: { readonly enabled: boolean; readonly initFired: boolean };
  readonly jotai: { readonly enabled: boolean; readonly atomsSeen: number; readonly setCaptured: boolean };
  readonly catalog: { readonly enabled: boolean; readonly tables: readonly string[] };
  readonly renumbering: { readonly enabled: boolean; readonly owns: boolean; readonly highestSeen: number };
  readonly storage: { readonly backend: string; readonly durable: boolean; readonly roundTrips: boolean };
  readonly hasPage: boolean;
}

/**
 * The attachment report for a client that has not attempted an attachment.
 *
 * Inline in the old `buildDetail`, where it was a five-field literal written out in the `??` branch. It is
 * named here because `roomConnectionRejected` is the only field a caller can use to tell "not yet attempted"
 * apart from "attempted and failed", so the string is part of the diagnostic contract rather than filler.
 */
const UNATTEMPTED_ATTACHMENT: AttachmentReport = {
  kind: 'none',
  roomConnection: { present: false },
  roomConnectionRejected: 'attachment has not been attempted yet',
  socketsSeen: 0,
  urlFilter: '',
  hasPage: false,
  renumberingInstalled: false,
};

/**
 * The page-shaped diagnostic: the body the pre-4.4 `report()` method had, unchanged in content.
 *
 * `hasPage` inside the fallback is the caller's, not {@link UNATTEMPTED_ATTACHMENT}'s: the page realm is
 * knowable before an attachment is attempted, so the fallback must not assert that there is none.
 * @internal
 */
export function buildDetail(input: DiagnosticsInput): BootstrapReport {
  return {
    version: BUNDLE_VERSION,
    attachment: input.attachment ?? { ...UNATTEMPTED_ATTACHMENT, hasPage: input.hasPage },
    storage: {
      backend: input.storage.backend,
      durable: input.storage.durable,
      roundTrips: input.storage.roundTrips,
    },
    render: {
      enabled: input.render.enabled,
      initFired: input.render.initFired,
      ctorsRecovered: input.ctorsRecovered,
    },
    jotai: {
      enabled: input.jotai.enabled,
      atomsSeen: input.jotai.atomsSeen,
      setCaptured: input.jotai.setCaptured,
    },
    catalog: {
      enabled: input.catalog.enabled,
      // Copied, not aliased: the caller's array is often a live view of the capture handle's table keys, and
      // a report that changes after it was read is not a snapshot.
      tables: [...input.catalog.tables],
    },
    renumbering: {
      enabled: input.renumbering.enabled,
      owns: input.renumbering.owns,
      highestSeen: input.renumbering.highestSeen,
    },
    hasPage: input.hasPage,
  };
}

/**
 * The contract's axes, as of the moment the snapshot was taken.
 * @internal
 */
export interface ReportAxes {
  readonly started: boolean;
  readonly ready: boolean;
  readonly selfPlayerId: string | null;
  readonly attachmentKind: string | null;
  readonly socketsSeen: number;
  readonly renumberingInstalled: boolean;
  readonly version: string;
  readonly errors: readonly MgErrorSummary[];
}

/**
 * One JSON-safe snapshot: the contract's axes, plus the page-shaped diagnostic as `detail`.
 * @internal
 */
export function buildReport(axes: ReportAxes, detail: BootstrapReport): BootstrappedReport {
  return {
    kind: 'bootstrapped',
    started: axes.started,
    ready: axes.ready,
    // Read from the same accessor the caller uses, so the report and `selfPlayerId` cannot disagree (I6).
    selfPlayerId: axes.selfPlayerId,
    attachment: axes.attachmentKind,
    socketsSeen: axes.socketsSeen,
    renumbering: axes.renumberingInstalled,
    // The same failure `lastError` reports, listed first, so the diagnostic surface and the accessor cannot
    // disagree about the most recent failure (I6).
    errors: axes.errors,
    version: axes.version,
    detail,
  };
}

/**
 * Every failure the client can report, most recent first: its own wiring error (when there is one) and then
 * whatever the core recorded. `report.errors` and `lastError` read the same two slots.
 *
 * The two arguments are the two slots rather than the client, because the ordering rule (*this client's own
 * failure first*) is the part that can be wrong, and it is worth a test that needs no client at all.
 * @internal
 */
export function errorSummaries(own: MgError | null, coreErrors: readonly MgErrorSummary[]): MgErrorSummary[] {
  const summarized = own === null ? [] : [summarizeError(own)];
  return [...summarized, ...coreErrors];
}

/**
 * The two facts the live attachment merge reads from one source.
 * @internal
 */
export interface AttachmentFacts {
  readonly report: AttachmentReport;
  /** The live socket count, or `null` when this source has no socket to count. */
  readonly socketCount: number | null;
}

/**
 * The live-resolved attachment snapshot, shared by `attachmentReport` and `report`.
 *
 * Two attachments can exist at once: the one that won, and the socket-path binding kept alive past an
 * upgrade because it owns the outbound renumbering seam. The seam's facts win where it has them, since it is
 * the newer source, and the winner's own report is the fallback, in that order.
 * @internal
 */
export function resolveAttachmentReport(
  attachment: AttachmentFacts | null,
  sendSeam: AttachmentFacts | null,
): AttachmentReport | null {
  if (attachment === null) return null;
  return {
    ...attachment.report,
    renumberingInstalled:
      attachment.report.renumberingInstalled || (sendSeam?.report.renumberingInstalled ?? false),
    socketsSeen: attachment.socketCount ?? sendSeam?.socketCount ?? attachment.report.socketsSeen,
  };
}
