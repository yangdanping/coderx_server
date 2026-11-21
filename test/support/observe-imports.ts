/** Observe resolved paths without wrapping tsx's loader, which can return a null source on Node 22. */
export const observeImports = `
  import { registerHooks } from 'node:module';
  import { fileURLToPath } from 'node:url';
  import { resolve } from 'node:path';
  const loaded = new Set();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const { url } = result;
      if (url.startsWith('file:')) loaded.add(fileURLToPath(url));
      return result;
    },
  });
`;
