// The built-in instruments, registered in Sound-menu order (the sub-ring fans them from up-left, around the bottom,
// to up-right). Adding an instrument = one file + one line here (docs/architecture.md "Instrument plugin").
import { registerInstrument } from "./registry.js";
import warm from "./warm.js";
import bright from "./bright.js";
import retro from "./retro.js";
import organ from "./organ.js";
import electric from "./electric/index.js";
import sax from "./sax.js";

for (const def of [warm, bright, retro, organ, electric, sax]) registerInstrument(def);

export * from "./registry.js";
