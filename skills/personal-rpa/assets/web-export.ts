interface Rpa {
  get(name: string): Promise<unknown>;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  output(value: unknown): Promise<void>;
}
export async function main(rpa: Rpa) {
  await rpa.call('browser.open', { url: await rpa.get('url') });
  const text = await rpa.call('browser.text', { selector: await rpa.get('selector') });
  const report = await rpa.call('file.xlsxWrite', { path: await rpa.get('reportFile'), rows: [{ text }] });
  await rpa.output({ text, report });
}
