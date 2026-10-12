// The message editor: a thin wrapper around Jodit.

import { onBeforeUnmount, onMounted, ref } from '/vendor/vue.js';
import { uploadImage } from './images.js';
import { loadScript, loadStyle } from './load.js';
import { problem } from './store.js';

const OPTIONS = {
  // No maxHeight: the box grows with the message and the page scrolls, rather than a short,
  // internally-scrolling box within the page — which also avoids Windows' non-overlay scrollbar
  // track staying visibly drawn the moment content gets even a pixel past a fixed cap.
  height: 'auto',
  minHeight: 360,
  toolbarAdaptive: false,
  toolbarSticky: false,
  statusbar: false,
  showCharsCounter: false,
  showWordsCounter: false,
  showXPathInStatusbar: false,
  askBeforePasteHTML: false,
  askBeforePasteFromWord: false,
  defaultActionOnPaste: 'insert_clear_html',
  placeholder: 'Write your message…',
  // The defaults fetch a code editor and a formatter from a CDN, which this app's security policy blocks.
  sourceEditor: 'area',
  beautifyHTML: false,
  // Images are first placed inline, then uploaded and swapped for a hosted address (see below).
  // That one path covers the image button, paste, and drag and drop.
  uploader: { insertImageAsBase64URI: true },
  // Keep the inline data on the image itself. By default Jodit shows it through a temporary
  // blob: address instead, which leaves nothing on the page to upload from.
  imageProcessor: { replaceDataURIToBlobIdInView: false },
  imageDefaultWidth: 568,
  buttons: 'bold,italic,underline,|,paragraph,fontsize,brush,|,ul,ol,align,|,link,image,hr,|,undo,redo,eraser,|,source',
};

const INLINE_IMAGE = 'img[src^="data:"]';
// An image in the editor's HTML that is not hosted yet.
const UNHOSTED = /<img\b[^>]*\ssrc\s*=\s*["'](data|blob):/i;

export const RichEditor = {
  props: { modelValue: String },
  emits: ['update:modelValue', 'uploading'],
  setup(props, { emit, expose }) {
    const host = ref(null);
    const uploading = new WeakSet();
    let jodit = null;

    async function upload(images) {
      const fresh = images.filter((image) => !uploading.has(image));
      if (!fresh.length) return;
      fresh.forEach((image) => uploading.add(image));
      await Promise.all(
        fresh.map(async (image) => {
          const inlineData = image.src;
          try {
            // The editor gives every new image the full width of the email. A smaller image
            // keeps its own size instead of being stretched.
            await image.decode().catch(() => {});
            if (image.naturalWidth && image.naturalWidth < Number(image.getAttribute('width'))) {
              image.setAttribute('width', image.naturalWidth);
            }
            image.src = await uploadImage(inlineData);
          } catch (error) {
            image.remove();
            problem(error);
          }
        }),
      );
      if (!jodit) return;
      jodit.synchronizeValues();
      publish();
    }

    // Content is only handed to the app once every image has a hosted address:
    // mail apps do not show inline data, and it would make the saved email huge.
    function publish() {
      // A blob: address belongs to another page (pasted content), so there is nothing to upload.
      const unreadable = jodit.editor.querySelectorAll('img[src^="blob:"]');
      if (unreadable.length) {
        unreadable.forEach((image) => image.remove());
        problem(new Error('A pasted image could not be read. Add it with the image button instead.'));
        jodit.synchronizeValues();
      }
      const inline = [...jodit.editor.querySelectorAll(INLINE_IMAGE)];
      if (inline.length) upload(inline);
      const html = jodit.value;
      const waiting = UNHOSTED.test(html);
      emit('uploading', waiting);
      if (!waiting) emit('update:modelValue', html);
    }

    onMounted(async () => {
      await Promise.all([loadStyle('/vendor/jodit.css'), loadScript('/vendor/jodit.js')]);
      if (!host.value) return;
      jodit = window.Jodit.make(host.value, OPTIONS);
      jodit.value = props.modelValue ?? '';
      jodit.events.on('change', publish);
    });

    onBeforeUnmount(() => {
      jodit?.destruct();
      jodit = null;
    });

    expose({
      /** Remembers the cursor before focus moves into a dialog. */
      hold: () => jodit?.s.save(),
      /** Puts the cursor back without inserting anything. */
      release: () => jodit?.s.restore(),
      /** Inserts HTML at the cursor. */
      insert(html) {
        if (!jodit) return;
        jodit.s.restore();
        jodit.s.insertHTML(html);
        jodit.synchronizeValues();
      },
    });

    return { host };
  },
  template: `<div class="editor"><textarea ref="host"></textarea></div>`,
};
