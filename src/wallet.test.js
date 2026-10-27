import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { encodePingCall, PING_SELECTOR, PORTALDOT_CHAIN, sendPingFromWallet, hasWallet } from "./wallet.js";

const ABI = parseAbi(["function ping(string note) returns (uint256 seq)"]);
const PING = "0x6a8705e4621dd87a261b1c5f97b73871616537ec";

test("wallet: the hand-written ping(string) encoding equals viem's, for short, empty, long and multi-byte notes", () => {
  assert.equal(PING_SELECTOR, toFunctionSelector("ping(string)"));
  for (const note of ["", "hello", "x".repeat(31), "x".repeat(32), "x".repeat(33), "x".repeat(60), "héllo wörld ✓", "🙂".repeat(15), "a b\tc"]) {
    assert.equal(encodePingCall(note), encodeFunctionData({ abi: ABI, functionName: "ping", args: [note] }), JSON.stringify(note));
  }
});

test("wallet: the Portaldot chain parameters match the network", () => {
  assert.equal(BigInt(PORTALDOT_CHAIN.chainId), 420420777n);
  assert.equal(PORTALDOT_CHAIN.nativeCurrency.decimals, 18);
});

const fakeWallet = (script = {}) => {
  const calls = [];
  return {
    calls,
    request: async ({ method, params }) => {
      calls.push({ method, params });
      const r = script[method];
      if (r instanceof Error) throw r;
      if (typeof r === "function") return r(params);
      return r;
    },
  };
};
const rejected = Object.assign(new Error("User rejected"), { code: 4001 });
const unknownChain = Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });

test("wallet: connects, is on the right chain, and sends exactly one ping call with no value", async () => {
  const w = fakeWallet({ eth_requestAccounts: ["0xabc0000000000000000000000000000000000001"], wallet_switchEthereumChain: null, eth_sendTransaction: "0x" + "12".repeat(32) });
  assert.equal(hasWallet({ ethereum: w }), true);
  assert.equal(hasWallet({}), false);
  const hash = await sendPingFromWallet("hi", PING, w);
  assert.equal(hash, "0x" + "12".repeat(32));
  const tx = w.calls.find((c) => c.method === "eth_sendTransaction").params[0];
  assert.equal(tx.to, PING);
  assert.equal(tx.value, "0x0");
  assert.equal(tx.data, encodePingCall("hi"));
  assert.equal(w.calls.filter((c) => c.method === "eth_sendTransaction").length, 1);
});

test("wallet: adds the Portaldot testnet when the wallet does not know it, and explains each refusal plainly", async () => {
  const acct = ["0xabc0000000000000000000000000000000000001"];
  const adds = fakeWallet({ eth_requestAccounts: acct, wallet_switchEthereumChain: unknownChain, wallet_addEthereumChain: null, eth_sendTransaction: "0x" + "34".repeat(32) });
  assert.equal(await sendPingFromWallet("x", PING, adds), "0x" + "34".repeat(32));
  assert.deepEqual(adds.calls.find((c) => c.method === "wallet_addEthereumChain").params[0], PORTALDOT_CHAIN);

  await assert.rejects(sendPingFromWallet("x", PING, undefined), /No wallet found/);
  await assert.rejects(sendPingFromWallet("x", PING, fakeWallet({ eth_requestAccounts: rejected })), /closed the wallet/);
  await assert.rejects(sendPingFromWallet("x", PING, fakeWallet({ eth_requestAccounts: [] })), /did not share an account/);
  await assert.rejects(sendPingFromWallet("x", PING, fakeWallet({ eth_requestAccounts: acct, wallet_switchEthereumChain: rejected })), /declined switching/);
  await assert.rejects(sendPingFromWallet("x", PING, fakeWallet({ eth_requestAccounts: acct, wallet_switchEthereumChain: unknownChain, wallet_addEthereumChain: rejected })), /declined adding/);
  await assert.rejects(sendPingFromWallet("x", PING, fakeWallet({ eth_requestAccounts: acct, wallet_switchEthereumChain: null, eth_sendTransaction: rejected })), /rejected the transaction/);
  await assert.rejects(sendPingFromWallet("x", PING, fakeWallet({ eth_requestAccounts: acct, wallet_switchEthereumChain: null, eth_sendTransaction: new Error("insufficient funds for gas") })), /no testnet tPOT/);
});
