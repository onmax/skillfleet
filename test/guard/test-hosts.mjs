// Loaded into every Node process a test starts (test/fixture.ts sets NODE_OPTIONS): a host under
// fleetrc.test resolves to 127.0.0.1, as git's http.curloptResolve maps the git server. A test
// server can then go by a name that is no loopback name, which a team manifest may name.
import dns from "node:dns";

const TEST_HOST = /(?:^|\.)fleetrc\.test\.?$/i;
const lookup = dns.lookup;

dns.lookup = function (hostname, options, callback) {
  if (typeof hostname !== "string" || !TEST_HOST.test(hostname))
    return lookup.apply(this, arguments);
  const done = typeof options === "function" ? options : callback;
  const all = typeof options === "object" && options !== null && options.all;
  if (all) process.nextTick(done, null, [{ address: "127.0.0.1", family: 4 }]);
  else process.nextTick(done, null, "127.0.0.1", 4);
};
