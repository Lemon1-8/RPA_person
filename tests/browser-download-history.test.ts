import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { removeTemporaryDownloadHistory } from '../packages/browser/src/download-history.js';

it('removes only owned temporary download records and their dependent rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-download-history-'));
  await mkdir(join(directory, 'Default'));
  const file = join(directory, 'Default', 'History');
  const guid = '7f136608-6b9a-4043-864b-31079fca52c0';
  const temporary = join(directory, 'temporary', guid);
  const history = new DatabaseSync(file);
  try {
    history.exec('CREATE TABLE downloads (id INTEGER PRIMARY KEY, guid TEXT, current_path TEXT, target_path TEXT); CREATE TABLE downloads_url_chains (id INTEGER, url TEXT); CREATE TABLE downloads_slices (download_id INTEGER); CREATE TABLE urls (url TEXT);');
    const insert = history.prepare('INSERT INTO downloads VALUES (?, ?, ?, ?)');
    insert.run(1, guid, temporary, temporary);
    insert.run(2, guid, 'C:\\Users\\Me\\Downloads\\manual.csv', 'C:\\Users\\Me\\Downloads\\manual.csv');
    insert.run(3, 'another-guid', temporary, temporary);
    history.exec("INSERT INTO downloads_url_chains VALUES (1, 'automatic'), (2, 'manual'), (3, 'unowned'); INSERT INTO downloads_slices VALUES (1), (2), (3); INSERT INTO urls VALUES ('https://retained-history.example/');");
  } finally { history.close(); }
  try {
    await removeTemporaryDownloadHistory(directory, [temporary]);
    const remaining = new DatabaseSync(file, { readOnly: true });
    try {
      expect(remaining.prepare('SELECT id FROM downloads ORDER BY id').all()).toEqual([{ id: 2 }, { id: 3 }]);
      expect(remaining.prepare('SELECT id FROM downloads_url_chains ORDER BY id').all()).toEqual([{ id: 2 }, { id: 3 }]);
      expect(remaining.prepare('SELECT download_id FROM downloads_slices ORDER BY download_id').all()).toEqual([{ download_id: 2 }, { download_id: 3 }]);
      expect(remaining.prepare('SELECT url FROM urls').get()?.url).toBe('https://retained-history.example/');
    } finally { remaining.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
