import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function thirdPartyNotices(root, builds) {
  const packages = new Map();
  const owners = new Map();
  async function owner(file) {
    let directory = path.dirname(path.resolve(root, file));
    const visited = [];
    while (directory.startsWith(root + path.sep)) {
      if (owners.has(directory)) {
        const found = owners.get(directory);
        for (const item of visited) owners.set(item, found);
        return found;
      }
      visited.push(directory);
      try {
        const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (info.name && info.version) {
          const found = { directory, info };
          for (const item of visited) owners.set(item, found);
          return found;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = path.dirname(directory);
    }
    throw new Error(`Cannot locate license owner for bundled dependency: ${file}`);
  }
  const inputs = new Set(builds.flatMap(build => Object.keys(build.metafile.inputs)).filter(file => file.replaceAll('\\', '/').includes('node_modules/')));
  inputs.add('node_modules/tailwindcss/index.css');
  for (const file of inputs) {
    const value = await owner(file);
    packages.set(`${value.info.name}@${value.info.version}`, value);
  }
  const parts = ['THIRD-PARTY SOFTWARE NOTICES\n\nThird-party components retain their respective copyrights and licenses.\n'];
  for (const [name, { directory, info }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const files = (await readdir(directory)).filter(name => /^(?:licen[sc]e|notice|copying)(?:[._-].*)?$/i.test(name)).sort();
    if (!files.length) throw new Error(`Bundled package has no license file: ${name}`);
    parts.push(`\n${'='.repeat(72)}\n${name}\nLicense: ${typeof info.license === 'string' ? info.license : JSON.stringify(info.license || info.licenses)}\n`);
    for (const file of files) parts.push(`\n--- ${file} ---\n${await readFile(path.join(directory, file), 'utf8')}\n`);
  }
  return parts.join('');
}
