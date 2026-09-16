import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Remove only this session's copied-away temporary downloads after the native browser exits. */
export async function removeTemporaryDownloadHistory(profileDir: string, paths: Iterable<string>): Promise<void> {
  const ownedPaths = [...paths];
  if (!ownedPaths.length) return;
  const historyPath = join(profileDir, 'Default', 'History');
  if (!await stat(historyPath).then(file => file.isFile(), () => false)) return;
  const { DatabaseSync } = await import('node:sqlite');
  const history = new DatabaseSync(historyPath);
  try {
    const tables = new Set((history.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
    if (!tables.has('downloads')) return;
    // Both GUID and exact path must match: browser history and manually saved downloads stay intact.
    const find = history.prepare('SELECT id FROM downloads WHERE guid = ? AND (current_path = ? OR target_path = ?)');
    const remove = history.prepare('DELETE FROM downloads WHERE id = ?');
    const removeChains = tables.has('downloads_url_chains') ? history.prepare('DELETE FROM downloads_url_chains WHERE id = ?') : undefined;
    const removeSlices = tables.has('downloads_slices') ? history.prepare('DELETE FROM downloads_slices WHERE download_id = ?') : undefined;
    history.exec('BEGIN IMMEDIATE');
    try {
      for (const path of ownedPaths) {
        const guid = basename(path);
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(guid)) continue;
        for (const row of find.all(guid, path, path) as Array<{ id: number }>) {
          removeChains?.run(row.id);
          removeSlices?.run(row.id);
          remove.run(row.id);
        }
      }
      history.exec('COMMIT');
    } catch (error) { history.exec('ROLLBACK'); throw error; }
  } finally { history.close(); }
}
