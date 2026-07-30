const fs = require('node:fs');
const path = require('node:path');

const packageTypes = [
  ['dist/esm', 'module'],
  ['dist/cjs', 'commonjs'],
];

for (const [directory, type] of packageTypes) {
  const outputDirectory = path.resolve(__dirname, '..', directory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, 'package.json'),
    `${JSON.stringify({ type }, null, 2)}\n`
  );
}
