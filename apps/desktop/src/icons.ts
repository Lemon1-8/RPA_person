import { nativeImage } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function createApplicationIcon(target: 'tray' | 'window' = 'tray'): Electron.NativeImage {
  const icon = nativeImage.createEmpty();
  const sizes = target === 'tray' ? [16, 20, 24, 32, 48, 64] : [256];
  const baseSize = sizes[0];
  for (const size of sizes) {
    const filename = join(__dirname, 'assets', `icon-${size}.png`);
    const buffer = readFileSync(filename);
    // 逐张检查资源；不要再次把无法解码的空图片交给 Windows 托盘。
    const representation = nativeImage.createFromBuffer(buffer);
    if (representation.isEmpty() || representation.getSize().width !== size || representation.getSize().height !== size) {
      throw new Error(`应用图标无效：${filename}`);
    }
    icon.addRepresentation({ buffer, scaleFactor: size / baseSize });
  }
  return icon;
}
