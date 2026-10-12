// Rules for files attached to a campaign. Shared by the browser, which checks before uploading,
// and the Worker, which checks again before storing.

/** A file is stored in parts of this many bytes, so each part fits in one database value. */
export const PART_BYTES = 1_400_000;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;

// Gmail refuses to send these (https://support.google.com/mail/answer/6590).
const BLOCKED = new Set(
  ('ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpkg dll dmg ex ex_ exe hta img ins iso isp ' +
    'jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc ' +
    'wsf wsh xll').split(' '),
);

export const partsFor = (size) => Math.max(1, Math.ceil(size / PART_BYTES));

export function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Why a file cannot be attached, or '' when it can.
 * @param attached the campaign's current attachments: [{ size }]
 */
export function attachmentProblem(name, size, attached) {
  const extension = String(name).split('.').pop().toLowerCase();
  if (String(name).includes('.') && BLOCKED.has(extension)) {
    return `Gmail does not send .${extension} files. Put the file online and link to it instead.`;
  }
  if (!(size > 0)) return `${name} is empty.`;
  if (attached.length >= MAX_FILES) return `An email can carry at most ${MAX_FILES} files.`;
  const total = attached.reduce((sum, file) => sum + file.size, 0) + size;
  if (total > MAX_TOTAL_BYTES) return `Attachments can add up to ${formatBytes(MAX_TOTAL_BYTES)} per email. ${name} would go over that.`;
  return '';
}
