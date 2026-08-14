// The rate-limit middleware fails closed when VERCEL_ENV=production and the
// Upstash credentials are absent. An ambient production env (e.g. after
// `vercel env pull`, `vercel build` locally, or a CI job mirroring the Vercel
// build environment) would make that throw fire at import time and crash every
// test file that (transitively) imports middleware.ts before any test runs.
//
// setupFiles execute before test files are imported, so neutralizing the vars
// here keeps the pre-existing tests on the in-memory fallback. The dedicated
// guard tests set the vars inside the test body, so they still exercise the
// production path.
delete process.env.VERCEL_ENV;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
