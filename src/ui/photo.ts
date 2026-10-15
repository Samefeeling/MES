// Camera shots on the shop floor — shared by the operator sheet's defect
// photos (PMD_Production attachments) and the die's SOC-note photos
// (PMD_DieMaster attachments).

/** Downscale + re-encode a camera shot: ≤1600px on the long edge, JPEG
 *  q0.72 ≈ 200-400 KB — enough to read a defect or a controller screen,
 *  small enough to queue in localStorage and to keep the SP attachment
 *  upload quick on shop WiFi. imageOrientation:'from-image' bakes the EXIF
 *  rotation in; the catch retries without options for engines that reject
 *  the dictionary. */
export async function compressPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() =>
    createImageBitmap(file),
  );
  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.72);
}

export function dataUrlToBlob(u: string): Blob {
  const [meta, b64] = u.split(',');
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
