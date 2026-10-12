// every module takes z from here, never from "zod" directly (eslint enforces it),
// so this config runs before any app schema is built. zod 4 probes for eval with
// new Function("") the first time it builds an object schema, then compiles a
// fast object parser with new Function. the production csp has no 'unsafe-eval',
// so the browser reports the probe as a securitypolicyviolation on page load even
// though zod catches the throw. jitless skips both and parses objects with the
// interpreted path, which is the path zod took under the csp anyway.
import { z } from "zod";

z.config({ jitless: true });

export { z };
