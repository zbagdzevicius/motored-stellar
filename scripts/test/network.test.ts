import { describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { assertTestnet, assertTestnetLive, mainnetReadOnly, NotTestnetError, TESTNET, testnetConfig } from '../lib/network.js';

describe('testnet guard', () => {
  it('accepts the testnet config', () => {
    expect(() => assertTestnet(TESTNET)).not.toThrow();
    expect(testnetConfig().passphrase).toBe(Networks.TESTNET);
  });

  it('rejects the mainnet passphrase', () => {
    expect(() => assertTestnet({ passphrase: Networks.PUBLIC, rpcUrl: TESTNET.rpcUrl })).toThrow(NotTestnetError);
    expect(() => assertTestnet(mainnetReadOnly('https://rpc.example.org'))).toThrow(/mainnet passphrase/);
  });

  it('rejects unknown passphrases', () => {
    expect(() => assertTestnet({ passphrase: 'Standalone Network ; February 2017', rpcUrl: 'http://localhost:8000' })).toThrow(/unknown passphrase/);
  });

  it('rejects a mainnet-looking RPC even with the testnet passphrase', () => {
    for (const rpcUrl of ['https://mainnet.sorobanrpc.com', 'https://soroban-rpc.pubnet.example', 'https://horizon.stellar.org']) {
      expect(() => assertTestnet({ passphrase: Networks.TESTNET, rpcUrl })).toThrow(/looks like mainnet/);
    }
    expect(() => testnetConfig('https://mainnet.sorobanrpc.com')).toThrow(NotTestnetError);
  });

  it('rejects an RPC that reports the mainnet passphrase', async () => {
    const liar = { getNetwork: async () => ({ passphrase: Networks.PUBLIC, protocolVersion: 23 }) };
    await expect(assertTestnetLive(liar as never, TESTNET)).rejects.toThrow(/RPC reports/);
    const honest = { getNetwork: async () => ({ passphrase: Networks.TESTNET, protocolVersion: 23 }) };
    await expect(assertTestnetLive(honest as never, TESTNET)).resolves.toBeUndefined();
  });
});
