# Dependency type patch

`happy-dom@21.0.4.patch` corrects the generated `BrowserWindow` declaration to use `typeof ReadableStream`, matching the package's source. The published declaration references `node:stream/web`'s `UnderlyingDefaultSource`, which is absent from the project's Node 22 type definitions. When upgrading Happy DOM, verify the new declaration against Node 22 and reapply the patch if it is still needed.
