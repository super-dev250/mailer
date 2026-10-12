// Images are shrunk in the browser before upload, so a phone photo does not become a 5 MB email image.

import { api } from './api.js';

const MAX_WIDTH = 1200; // twice the 600px email width, sharp on high-density screens
const MAX_BYTES = 1_400_000; // what the app stores per image

function dataUrlToBlob(dataUrl) {
  if (!dataUrl.startsWith('data:') || !dataUrl.includes(',')) throw new Error('Could not read that image. Try adding it again.');
  const [head, body] = dataUrl.split(',');
  const type = head.match(/^data:([^;,]+)/)?.[1] ?? 'application/octet-stream';
  const text = head.includes(';base64') ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Blob([bytes], { type });
}

export const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(blob);
  });

function draw(bitmap, width, height, type) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d');
  if (type === 'image/jpeg') {
    // JPEG has no transparency: without this, transparent areas turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
}

async function shrink(blob) {
  const tooLarge = new Error('That image is too large. Use one smaller than 1.4 MB.');
  // Animated GIFs would lose their animation on a canvas, so they go up as they are.
  if (blob.type === 'image/gif') {
    if (blob.size > MAX_BYTES) throw tooLarge;
    return blob;
  }
  const bitmap = await createImageBitmap(blob).catch(() => {
    throw new Error('That file is not an image this app can use. Try a PNG or JPEG.');
  });
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const isPng = blob.type === 'image/png';
  if (scale === 1 && blob.size <= MAX_BYTES && (isPng || blob.type === 'image/jpeg')) return blob;

  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  let result = await draw(bitmap, width, height, isPng ? 'image/png' : 'image/jpeg');
  if (isPng && result.size > MAX_BYTES) result = await draw(bitmap, width, height, 'image/jpeg');
  if (!result || result.size > MAX_BYTES) throw tooLarge;
  return result;
}

/** Uploads an image given as a data: URL and returns its public address. */
export async function uploadImage(dataUrl) {
  const blob = await shrink(dataUrlToBlob(dataUrl));
  const { url } = await api.post('/api/images', { type: blob.type, data: await blobToBase64(blob) });
  return url;
}
