// Creates a foreign (different key, no receipts) trust DB for F1b.
const { TrustStore } = await import('/tmp/e9/mcp-server/src/trust-store.ts');
const s = new TrustStore(process.argv[2]); s.close(); console.log('created', process.argv[2]);
