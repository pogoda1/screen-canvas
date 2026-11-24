import { nativeImage } from 'electron';
import { frameRect } from './capture.mjs';

const prefix = 'data:image/png;base64,';

export function matchControl(frame, screenshot, { x, y, box }) {
  if (!frame || !screenshot?.startsWith(prefix)) return;
  const { width, height } = frameRect;
  if (box.width < 4 || box.height < 4 || box.x < 0 || box.y < 0 ||
      box.x + box.width > width || box.y + box.height > height) return;
  const source = nativeImage.createFromBuffer(Buffer.from(screenshot.slice(prefix.length), 'base64'));
  const size = source.getSize();
  const scale = size.width / width;
  if (!scale || size.height !== height * scale ||
      frame.getSize().width !== size.width || frame.getSize().height !== size.height) return;
  const left = Math.floor(box.x * scale);
  const top = Math.floor(box.y * scale);
  const rect = { x: left, y: top, width: Math.floor((box.x + box.width) * scale) - left,
    height: Math.floor((box.y + box.height) * scale) - top };
  const actual = frame.crop(rect).toBitmap();
  const shown = source.crop(rect).toBitmap();
  // A completely blank area provides no visual evidence of a control.
  if (!shown.length || !actual.equals(shown) ||
      !shown.some((channel, index) => index >= 4 && channel !== shown[index % 4])) return;
  return { x: x / width, y: y / height };
}
