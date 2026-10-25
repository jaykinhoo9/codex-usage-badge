class ThreadTokenReader {
  constructor({ home = process.env.CODEX_HOME || require('node:path').join(require('node:os').homedir(), '.codex') } = {}) {
    this.home = home;
    this.chatTimes = new LastChatTimeCache();
  }
  read(ids) {
    const checkedAt = Date.now();
    const totals = Object.create(null);
    const details = Object.create(null);
    this.chatTimes.beginRead();
    const requested = [...new Set(ids)].filter(id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)).slice(0, 2000);
    if (!requested.length) return { ok: true, totals, details, checkedAt };
    let db;
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      // Follow the latest local state database; never fall back to an older account snapshot.
      const file = fs.readdirSync(this.home).filter(name => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
      if (!file) return { ok: false, totals, details, checkedAt };
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(path.join(this.home, file), { readOnly: true, timeout: 200 });
      // Token totals stay independent of optional session-file metadata.
      for (let i = 0; i < requested.length; i += 200) {
        const chunk = requested.slice(i, i + 200);
        const rows = db.prepare(`SELECT id, tokens_used FROM threads WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
        for (const row of rows) if (Number.isSafeInteger(row.tokens_used) && row.tokens_used >= 0) totals[row.id] = row.tokens_used;
        // Expose only metadata; inspect message envelopes solely for their timestamps.
        try {
          const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
          const fields = ['rollout_path', 'created_at_ms', 'created_at'].filter(field => columns.has(field));
          if (fields.length) {
            const metadata = db.prepare(`SELECT id, ${fields.join(', ')} FROM threads WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
            const realHome = fs.realpathSync(this.home);
            for (const row of metadata) {
              const createdAt = Number.isSafeInteger(row.created_at_ms) && row.created_at_ms > 0 ? row.created_at_ms
                : Number.isSafeInteger(row.created_at) && row.created_at > 0 ? row.created_at * 1000 : null;
              const detail = { createdAt, bytes: null, chatAt: null };
              details[row.id] = detail;
              try {
                if (typeof row.rollout_path !== 'string' || !path.isAbsolute(row.rollout_path)) continue;
                const file = fs.realpathSync(row.rollout_path);
                const relative = path.relative(realHome, file).split(path.sep);
                if (!['sessions', 'archived_sessions'].includes(relative[0]) || !file.endsWith('.jsonl')) continue;
                const stat = fs.statSync(file);
                if (!stat.isFile()) continue;
                if (Number.isSafeInteger(stat.size) && stat.size >= 0) detail.bytes = stat.size;
                detail.chatAt = this.chatTimes.read(file, stat);
              } catch { /* Missing or inaccessible files never suppress Token totals. */ }
            }
          }
        } catch { /* Optional metadata must not break older database schemas. */ }

      }
      return { ok: true, totals, details, checkedAt };
    } catch {
      return { ok: false, totals: Object.create(null), details: Object.create(null), checkedAt };
    } finally { try { db?.close(); } catch {} }
  }
}
async function refreshThreadTokens(injector, reader) {
  const sessions = [...injector.sessions.values()];
  if (!sessions.length) return;
  const requests = await Promise.all(sessions.map(async session => {
    try {
      const result = await session.evaluate('window.__codexThreadTokens?.requestedIds() ?? []');
      const ids = result?.result?.value;
      return { session, ids: Array.isArray(ids) ? ids : [] };
    } catch { return { session, ids: [] }; }
  }));
  const snapshot = reader.read(requests.flatMap(r => r.ids));
  await Promise.all(requests.map(async ({ session, ids }) => {
    const totals = Object.fromEntries(ids.filter(id => Object.hasOwn(snapshot.totals, id)).map(id => [id, snapshot.totals[id]]));
    const details = Object.fromEntries(ids.filter(id => Object.hasOwn(snapshot.details ?? {}, id)).map(id => [id, snapshot.details[id]]));
    try { await session.evaluate(`window.__codexThreadTokens?.update(${JSON.stringify({ ...snapshot, totals, details })})`); } catch {}
  }));
}
