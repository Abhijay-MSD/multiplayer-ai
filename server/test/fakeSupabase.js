// Minimal in-memory stand-in for the Supabase client: just the query surface
// the context and summary code use (select/eq/in/gt/order/limit/maybeSingle/
// single/update/insert). Rows live in plain arrays: db.tables.<name>.
// `latencyMs` delays every query, to stand in for the network round trip to a remote Supabase.
import { randomUUID } from "node:crypto";

export function makeFakeSupabase(tables, { latencyMs = 0 } = {}) {
  const db = { tables };
  const lag = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : null);
  db.from = (name) => {
    const rows = () => (tables[name] ??= []);
    const q = { op: "select", filters: [], order: null, limit: null, patch: null, row: null, cols: null };
    // select("a, b") returns only those columns, like the real client. Without
    // it, or with "*", every column comes back.
    const project = (r) => {
      if (!q.cols) return r;
      return Object.fromEntries(q.cols.filter((c) => c in r).map((c) => [c, r[c]]));
    };
    const run = () => {
      let out = rows().filter((r) => q.filters.every((f) => f(r)));
      if (q.op === "update") {
        out.forEach((r) => Object.assign(r, q.patch));
        return { data: out.map(project), error: null };
      }
      if (q.op === "insert") {
        // sessions get a uuid like the real table does; the other tables count up
        const r = { id: name === "sessions" ? randomUUID() : rows().length + 1, ...q.row };
        rows().push(r);
        return { data: [project(r)], error: null };
      }
      if (q.order) out = [...out].sort((a, b) => (a[q.order.col] - b[q.order.col]) * (q.order.asc ? 1 : -1));
      if (q.limit != null) out = out.slice(0, q.limit);
      return { data: out.map((r) => ({ ...project(r) })), error: null };
    };
    const api = {
      select: (cols) => {
        const list = typeof cols === "string" && cols.trim() !== "*" ? cols.split(",").map((c) => c.trim()) : null;
        if (list) q.cols = list;
        return api;
      },
      update: (patch) => ((q.op = "update"), (q.patch = patch), api),
      insert: (row) => ((q.op = "insert"), (q.row = row), api),
      eq: (c, v) => (q.filters.push((r) => r[c] === v), api),
      in: (c, vs) => (q.filters.push((r) => vs.includes(r[c])), api),
      gt: (c, v) => (q.filters.push((r) => r[c] != null && r[c] > v), api),
      lte: (c, v) => (q.filters.push((r) => r[c] != null && r[c] <= v), api),
      is: (c, v) => (q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)), api),
      order: (col, { ascending = true } = {}) => ((q.order = { col, asc: ascending }), api),
      limit: (n) => ((q.limit = n), api),
      maybeSingle: async () => (await lag(), { data: run().data[0] ?? null, error: null }),
      single: async () => (await lag(), { data: run().data[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve(lag()).then(run).then(res, rej)
    };
    return api;
  };
  // The one stored function the code calls. It mirrors claim_step() in migration
  // 0004: take a step from today's (UTC) count unless it has reached the cap.
  // `rpcLog` records every call, so a test can prove a code path never made one.
  db.rpcLog = [];
  db.rpc = async (fn, args) => {
    db.rpcLog.push({ fn, args });
    if (db.rpcError) return { data: null, error: { message: db.rpcError } };
    if (fn !== "claim_step") return { data: null, error: { message: `unknown function ${fn}` } };
    const day = new Date().toISOString().slice(0, 10);
    const rows = (tables.usage_daily ??= []);
    let row = rows.find((r) => r.day === day);
    if (!row) rows.push((row = { day, steps: 0 }));
    const allowed = row.steps < args.p_cap;
    if (allowed) row.steps += 1;
    return { data: [{ allowed, used: row.steps }], error: null };
  };
  return db;
}
