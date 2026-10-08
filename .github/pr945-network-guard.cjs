const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (Array.isArray(args[0])) args = args[0];
  const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  const host = options.host || 'localhost';
  if (!options.path && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw Object.assign(new Error('External network disabled for verification'), { code: 'ENETUNREACH' });
  }
  return original.apply(this, args);
};

const allowed = value => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? input : input.url;
  if (!allowed(url)) return Promise.reject(Object.assign(new Error('External fetch disabled for verification'), { code: 'ENETUNREACH' }));
  return originalFetch(input, init);
};
