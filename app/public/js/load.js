// Loads the large libraries (editor, spreadsheet reader) only on the screens that use them.

const loaded = new Map();

function once(url, create) {
  if (!loaded.has(url)) {
    loaded.set(
      url,
      new Promise((resolve, reject) => {
        const element = create();
        element.onload = resolve;
        element.onerror = () => {
          loaded.delete(url);
          reject(new Error(`Could not load ${url}. Reload the page and try again.`));
        };
        document.head.append(element);
      }),
    );
  }
  return loaded.get(url);
}

export const loadScript = (url) => once(url, () => Object.assign(document.createElement('script'), { src: url }));
export const loadStyle = (url) =>
  once(url, () => Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url }));
