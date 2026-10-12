import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_FILES, PART_BYTES, attachmentProblem, formatBytes, partsFor } from '../app/public/shared/attachments.js';

test('files Gmail refuses, empty files and too much in total are turned away', () => {
  assert.match(attachmentProblem('driver-app.apk', 1000, []), /Gmail does not send \.apk files/);
  assert.match(attachmentProblem('SETUP.EXE', 1000, []), /\.exe/);
  assert.match(attachmentProblem('empty.pdf', 0, []), /empty/);
  assert.match(attachmentProblem('big.pdf', 11 * 1024 * 1024, []), /10\.0 MB/);
  assert.match(attachmentProblem('one-more.pdf', 6 * 1024 * 1024, [{ size: 5 * 1024 * 1024 }]), /would go over/);
  assert.match(attachmentProblem('sixth.pdf', 10, Array.from({ length: MAX_FILES }, () => ({ size: 10 }))), /at most 5 files/);
  assert.equal(attachmentProblem('flyer.pdf', 2 * 1024 * 1024, [{ size: 1024 }]), '');
  assert.equal(attachmentProblem('README', 10, []), '', 'a name without an extension is fine');
});

test('a file is stored in as many parts as it needs', () => {
  assert.equal(partsFor(1), 1);
  assert.equal(partsFor(PART_BYTES), 1);
  assert.equal(partsFor(PART_BYTES + 1), 2);
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3.5 * 1024 * 1024), '3.5 MB');
});
