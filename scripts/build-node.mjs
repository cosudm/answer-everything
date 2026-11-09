// Bundles a Node entrypoint with esbuild. Workspace packages (@ae/*) are
// bundled in; everything from node_modules stays external so native deps and
// pino transports keep working.
//
//   node ../../scripts/build-node.mjs src/server.ts dist/server.js [more pairs...]
import { build } from "esbuild";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.error("usage: build-node.mjs <entry> <outfile> [<entry> <outfile> ...]");
  process.exit(1);
}

const externalizeNodeModules = {
  name: "externalize-node-modules",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@ae/")) return null; // bundle workspace packages
      if (args.path.startsWith("node:")) return { path: args.path, external: true };
      return { path: args.path, external: true };
    });
  },
};

for (let i = 0; i < args.length; i += 2) {
  const entry = args[i];
  const outfile = args[i + 1];
  await build({
    entryPoints: [path.resolve(entry)],
    outfile: path.resolve(outfile),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    logLevel: "info",
    plugins: [externalizeNodeModules],
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });
}
