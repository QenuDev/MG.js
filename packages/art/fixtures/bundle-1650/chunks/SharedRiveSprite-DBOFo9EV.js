// biome-ignore-all lint format: a fixture is a cut of a minified chunk, parsed by the extractor and never run; reformatting it would move the byte ranges the manifest records.
const H = .4;
const U = .6;
function ce(e){switch(e.itemType){case t.Produce:return H;case t.Plant:return U;default:return 1}}
function W(e,t){return t*ce(e)}
