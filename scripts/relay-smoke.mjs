import { blockedHost } from "../worker/relay.js";

const blocked = [
  "localhost",
  "127.0.0.1",
  "10.0.0.5",
  "172.16.4.1",
  "172.31.255.1",
  "192.168.1.9",
  "169.254.169.254",
  "printer.local",
  "metadata.google.internal",
  "::1",
  "[fd00::1]",
  "::ffff:127.0.0.1",
];
const allowed = ["amr-link.open-design.ai", "8.8.8.8", "172.32.0.1", "fdic.gov", "example.com"];

for (const host of blocked) {
  if (!blockedHost(host)) throw new Error(`relay should block ${host}`);
}
for (const host of allowed) {
  if (blockedHost(host)) throw new Error(`relay should allow ${host}`);
}

console.log(JSON.stringify({ blocked: blocked.length, allowed: allowed.length }));
