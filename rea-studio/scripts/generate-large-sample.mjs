import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(".local", `owned-large-sample-${Date.now()}`);
await mkdir(root, { recursive: true });
await writeFile(
  resolve(root, "package.json"),
  JSON.stringify({
    name: "studio-owned-large-sample",
    version: "1.0.0",
    type: "module",
    main: "main.js",
    license: "MIT",
  }),
  { flag: "wx" },
);
const imports = [];
for (let i = 0; i < 100; i++) {
  await writeFile(
    resolve(root, `module-${i}.js`),
    `export function value${i}(input) { return { kind: 'sample-${i}', value: input + ${i} }; }\n`,
    { flag: "wx" },
  );
  imports.push(`import { value${i} } from './module-${i}.js';`);
}
await writeFile(
  resolve(root, "main.js"),
  imports.join("\n") +
    "\nexport const transforms = [" +
    Array.from({ length: 100 }, (_, i) => `value${i}`).join(", ") +
    "];\n",
  { flag: "wx" },
);
console.log(root);
