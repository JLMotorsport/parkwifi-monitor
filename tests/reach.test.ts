import net from 'net';
import { describe, expect, it } from 'vitest';
import { tcpPing } from '../src/core/ping';

describe('tcpPing', () => {
  it('times connections to an open port', async () => {
    const srv = net.createServer((s) => s.destroy()).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    const r = await tcpPing('127.0.0.1', port, 3);
    srv.close();
    expect(r.received).toBe(3);
    expect(r.via).toBe(`tcp:${port}`);
    expect(r.avg).not.toBeNull();
  });
  it('counts a refused connection as an answer', async () => {
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    srv.close();
    await new Promise((r) => setTimeout(r, 50));
    const r = await tcpPing('127.0.0.1', port, 2);
    expect(r.received).toBe(2);
  });
});
