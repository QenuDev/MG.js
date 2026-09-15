/**
 * Fail when wire vocabulary leaks into the domain surface.
 *
 * A mod author should never have to learn the word "slot". It is the protocol's word for three different
 * things: a player's array position in `userSlots`, a tile's key in `tileObjects` (the command field
 * `slot`), and a crop's own id (the command field `slotsIndex`). A previous revision of the state API
 * exposed all three under that one word, which is how `state.slot(0).garden.plot(0)` came to exist: a
 * caller had to know which slot was meant before they could read a crop.
 *
 * ## Why this is a gate and not a style note
 *
 * The rule is easy to state and easy to break, because the offending name always looks reasonable in
 * isolation: `SlotData`, `slotIndex`, `myGardenSlot`, `Tile.index`. Every one of those was shipped and
 * every one had to be removed by hand. `slotsIndex` in particular is correct for the *action* layer and
 * wrong for the read model, so this checks the state module specifically rather than the whole barrel.
 *
 * ## What is deliberately still allowed
 *
 * `actions`, `protocol` and `paths` name wire fields, because that is what they are: `SlotParams` is the
 * shape of a command whose field really is called `slot`, and `USER_SLOTS` is the path the server sends.
 * Renaming those would hide the wire rather than model it. The rule here is about the read model a mod
 * writes against, not about the protocol's own vocabulary at the protocol's own layer.
 */

import { readFileSync } from 'node:fs';
import { convert, MANIFEST_PATH } from './surface.mjs';

/** Modules whose exported names are the wire's own, and are meant to be. */
const WIRE_LAYERS = new Set(['common/actions', 'common/protocol']);

/** Words that describe the protocol's addressing, never the domain. */
const WIRE_WORDS = /(slot|tileObject|growSlot|localTileIndex)/i;

/**
 * The only names allowed to carry a wire word outside the wire layers, each with the reason it is not the
 * addressing vocabulary this gate exists to stop.
 *
 * Each entry must be a genuine second sense of the word. `USER_SLOTS` is the path to the wire field, so it
 * is the wire's name for itself. The other two are a different word entirely: a weather "slot" is a time
 * window, and a coexistence "slot" is a place in a bundle of userscripts. A new entry here should be rare,
 * and needs a sentence saying why the word means something else.
 */
const ALLOWED = new Map([
  ['common/state:USER_SLOTS', 'the path constant to the wire field itself'],
  ['common/catalog:WeatherSlot', 'a time window in the weather forecast, not an address'],
  ['common/catalog:normaliseWeatherSlot', 'a time window in the weather forecast, not an address'],
  ['bootstrapped/coexistence:SlotClass', 'a place in a bundle of coexisting userscripts'],
  ['bootstrapped/coexistence:SendSlot', 'a place in a bundle of coexisting userscripts'],
  ['bootstrapped/coexistence:classifySlot', 'a place in a bundle of coexisting userscripts'],
  ['bootstrapped/coexistence:restoreSlot', 'a place in a bundle of coexisting userscripts'],
]);

const { project } = await convert();

/** Every exported name by module, read from the committed surface so this and `docs:check` agree. */
function surfaceNames() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).modules;
  } catch (error) {
    console.error(`check-naming: cannot read ${MANIFEST_PATH}: run \`npm run docs:build\` first.`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const byModule = new Map();
  for (const [moduleName, kinds] of Object.entries(manifest)) {
    const names = [];
    for (const list of Object.values(kinds)) names.push(...list);
    byModule.set(moduleName, names);
  }
  void project;
  return byModule;
}

const offenders = [];
for (const [moduleName, names] of surfaceNames()) {
  if (WIRE_LAYERS.has(moduleName)) continue;
  for (const name of names) {
    if (!WIRE_WORDS.test(name)) continue;
    if (ALLOWED.has(`${moduleName}:${name}`)) continue;
    offenders.push(`${moduleName}: ${name}`);
  }
}

if (offenders.length === 0) {
  console.log('check-naming: no wire vocabulary in the domain surface');
  process.exit(0);
}

console.error("check-naming: the read model exposes the protocol's own words.");
console.error('');
for (const line of offenders.sort()) console.error(`    ${line}`);
console.error('');
console.error('  A caller should not have to know that "slot" means a player position, a tile key, or a');
console.error('  crop id. Name the domain instead: see `state/entities.ts` for the shapes this replaces.');
console.error('');
console.error('  If a name here is a different sense of the word, add it to ALLOWED in this file with the');
console.error('  reason, so the exception is reviewed rather than assumed.');
process.exit(1);
