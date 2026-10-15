// Express 4 ignores the promise an async handler returns. If that promise
// rejects, Node sees an unhandled rejection (which kills the process on
// Node 15+) and the request hangs until the CDN gives up with a 504.
//
// This patches Express's Layer so a rejected promise is forwarded to
// next(err), exactly like a thrown error. Same idea as the
// `express-async-errors` package, without adding a dependency.
// Import this module once, before any router is created.
import Layer from 'express/lib/router/layer.js';

const patched = Symbol.for('orblood.asyncErrorsPatched');

if (!Layer.prototype[patched]) {
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    // Error handlers have 4 args; Express skips them here, keep that.
    if (fn.length > 3) return next();
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.then === 'function') ret.catch(next);
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype[patched] = true;
}
