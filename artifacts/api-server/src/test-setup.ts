// Vitest global setup. Importing @workspace/db throws unless DATABASE_URL is
// set, and the suite has no live Postgres. Point it at a dummy URL so module
// imports succeed; no connection is opened because no query runs.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://opennode:opennode@localhost:5432/opennode_test";
}
