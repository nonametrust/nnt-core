// The public surface of @nonametrust/store: repositories, errors and the
// connection are exported; the SQL is not. A consumer needing a query this
// package does not offer gets a repository method, not a query builder.
//
// THE SENTENCE CHANGED WITH R20, and the old one is worth recording because it
// was measured false. It said the connection is NOT exported -- and every
// repository constructor takes a `Db`, so the surface as declared could not
// construct its own repository. The built `dist/index.d.ts` carried none of
// `openDb`, `Db`, `Schema` or `withIsoDates`, which left a consumer reaching
// past this file into `dist/db.js`. That resolves, because `package.json` has no
// `exports` field.
//
// So `openDb` and the `Db` type are exported and `Schema`, `withIsoDates` and
// `refuseWriteInsideTransaction` are not: a consumer may hold a connection, and
// may not hold this package's column list or reach for its connection pins.
// `retention.ts` was already exported on exactly this argument, one value short
// of its conclusion.
//
// AND THE BOUNDARY IS STILL A CONVENTION. With no `exports` field a deep import
// resolves whatever this file says, so what refuses one is the consumer's own
// gate -- `packages/engine/src/boundary.test.ts` does, by name. Stated rather
// than implied, because a boundary that is a convention and reads like a
// mechanism is the shape F7 already cost this milestone once.
export * from "./clock.js";
export { openDb } from "./db.js";
export type { Db } from "./db.js";
export * from "./errors.js";
export { migrate } from "./migrate.js";
export * from "./crypto.js";
// Exported here rather than in the final task, because NamespaceRepository's
// constructor now requires a RetentionPolicy: without this, the package's
// public surface cannot construct its own repository and a consumer would
// have to reach past index.ts for the value and the type.
export * from "./retention.js";
export * from "./repositories/namespace.js";
export * from "./repositories/observation.js";
export * from "./repositories/tag.js";
export * from "./repositories/permanent-record.js";
export * from "./repositories/baseline.js";
export * from "./repositories/trigger-event.js";
export * from "./repositories/volatility.js";
export * from "./repositories/hot-window.js";
export * from "./audit/chain.js";
export * from "./strength.js";
