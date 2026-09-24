// registry.js — shared namespace the extension modules attach themselves to.
//
// Nova's CommonJS require() cannot handle circular dependencies, and the
// bridge / tools / sidebar modules genuinely call into each other. So
// instead of requiring one another they each do
//   const R = require("./registry.js"); … R.Tools = Object.assign(R.Tools || {}, { … });
// and call siblings as R.Tools.fn() at run time. main.js requires every
// module once; the dependency graph is then a star around this object.

module.exports = {};
