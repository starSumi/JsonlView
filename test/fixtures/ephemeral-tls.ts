import { generateKeyPairSync, sign } from 'node:crypto';

/** Minimal DER encoding for a short-lived, self-signed loopback test certificate. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts);
  const bytes: number[] = [];
  for (let length = value.length; length > 0; length >>>= 8) bytes.unshift(length & 255);
  const length = value.length < 128 ? Buffer.from([value.length]) : Buffer.from([128 | bytes.length, ...bytes]);
  return Buffer.concat([Buffer.from([tag]), length, value]);
}

/** Keys exist only in this test process; no reusable private key is committed. */
export function createEphemeralLoopbackTls(): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = der(48, der(6, Buffer.from('2a864886f70d01010b', 'hex')), der(5));
  const name = der(48, der(49, der(48, der(6, Buffer.from('550403', 'hex')), der(12, Buffer.from('127.0.0.1')))));
  const time = (offset: number) => der(24, Buffer.from(new Date(Date.now() + offset).toISOString().replace(/[-:T]/gu, '').replace(/\.\d{3}Z$/u, 'Z')));
  const extensions = der(163, der(48,
    der(48, der(6, Buffer.from('551d13', 'hex')), der(1, Buffer.from([255])), der(4, der(48, der(1, Buffer.from([255]))))),
    der(48, der(6, Buffer.from('551d11', 'hex')), der(4, der(48, der(135, Buffer.from([127, 0, 0, 1]))))),
  ));
  const body = der(48, der(160, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    der(48, time(-86_400_000), time(86_400_000)), name, publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const certificate = der(48, body, algorithm, der(3, Buffer.from([0]), sign('sha256', body, privateKey)));
  const base64 = certificate.toString('base64').match(/.{1,64}/gu)!.join('\n');
  return { cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
