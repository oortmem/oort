import '@testing-library/jest-dom/vitest';

// Server tests opt into the node environment, where there is no window.
if (typeof window !== 'undefined') installBrowserStubs();

function installBrowserStubs() {
  Object.defineProperty(window, 'scrollTo', {
    writable: true,
    value: () => {},
  });

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
