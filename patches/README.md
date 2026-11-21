# Dependency type patch

`happy-dom@20.14.5.patch` corrects the generated `BrowserWindow` declaration to use `typeof ReadableStream`, matching the package's source. The published expanded declaration references a Node 26 type absent from the Node 22 type definitions. This patch changes no runtime code; remove it when the upstream declaration is compatible with Node 22 types.
