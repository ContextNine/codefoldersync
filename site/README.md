# Code Folder Sync site

Local-only CTX9-style landing page and user documentation for Code Folder Sync.

## Run locally

```bash
npm install
npm run dev -- --hostname 127.0.0.1
```

For another machine on the private Wootbook WireGuard network:

```bash
npm run dev -- --hostname 10.13.13.10
```

The site has no database, account flow, analytics, external runtime dependency,
or deployment configuration beyond the inert Sites capability declaration. It
must remain localhost-only until an explicit hosting decision is made.

## Verify

```bash
npm run lint
npm test
```

`npm test` performs a production build and checks the rendered landing page and
one representative documentation route.
