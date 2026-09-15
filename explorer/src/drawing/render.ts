import { geometryPath, strokeGeometry, validateDrawing } from '../../shared/drawing.mjs';
import type { Review } from './types';

export function validateReviewImage(image: Review['image']): void {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width < 1 || image.height < 1 || image.width > 16384 || image.height > 16384
    || image.width * image.height > 32_000_000) {
    throw new Error('Captured image must have positive integer dimensions, at most 16384 per side and 32 million pixels.');
  }
  if (typeof image.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(image.dataUrl)
    || image.dataUrl.length > 48_000_000) {
    throw new Error('Captured image must be a valid bounded PNG data URL.');
  }
}

export async function composeReviewImage(review: Review): Promise<Blob> {
  validateReviewImage(review.image);
  const drawing = validateDrawing(review.drawing);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      image.onload = null;
      image.onerror = null;
      image.src = '';
      reject(new Error('Captured image could not be decoded in time.'));
    }, 15000);
    image.onload = () => { window.clearTimeout(timer); resolve(); };
    image.onerror = () => { window.clearTimeout(timer); reject(new Error('Captured PNG is corrupt or cannot be decoded.')); };
    image.src = review.image.dataUrl;
  });
  if (image.naturalWidth !== review.image.width || image.naturalHeight !== review.image.height) {
    throw new Error('Captured PNG dimensions do not match the review.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = review.image.width;
  canvas.height = review.image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image composition requires a working 2D canvas.');
  context.drawImage(image, 0, 0);
  for (const stroke of drawing.present) {
    context.lineWidth = stroke.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    for (const geometry of strokeGeometry(stroke, canvas.width, canvas.height)) {
      context.globalAlpha = geometry.opacity;
      const path = new Path2D(geometryPath(geometry));
      if (geometry.fill) context.fill(path);
      else context.stroke(path);
    }
  }
  context.globalAlpha = 1;
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob && blob.type === 'image/png' && blob.size > 0) resolve(blob);
      else reject(new Error('Could not encode the marked image as PNG.'));
    }, 'image/png');
  });
}
